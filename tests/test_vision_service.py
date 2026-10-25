"""VisionService against a fake model backend: photo checks, the in-memory cache, one photo at a time, cleaning the
reply for speech, and failure containment. No llama-server or model is needed.

Run: pytest tests/test_vision_service.py
"""

import asyncio
import io

import pytest
from PIL import Image

from core.enums import ExceptionCode
from domain.entities.vision import VisionStatus
from exceptions.exception import AppException
from schemas.config_schemas import VisionConfig
from service.vision.prompts import STYLE_PROMPTS
from service.vision.text_cleaner import SpeechCleaner
from service.vision.vision_service import VisionService


def run(coro):
    return asyncio.run(coro)


def jpeg(size=(400, 300), color=(200, 30, 30), exif=None, fmt="JPEG") -> bytes:
    buf = io.BytesIO()
    kwargs = {"exif": exif} if exif is not None else {}
    Image.new("RGB", size, color).save(buf, fmt, **kwargs)
    return buf.getvalue()


class FakePort:
    """Stands in for the llama-server adapter: scripted chunks, records what it was asked, can be held open."""

    def __init__(self, chunks=("A red ", "apple."), error=None, hold: asyncio.Event | None = None, cleanup_delay=0.0):
        self.chunks, self.error, self.hold, self.cleanup_delay = list(chunks), error, hold, cleanup_delay
        self.calls = []
        self.cleanup_done = False
        self.stopped = False

    async def describe(self, image, mime, prompt, *, cancel):
        self.calls.append((image, mime, prompt))
        self.cleanup_done = False
        try:
            if self.error is not None:
                raise self.error
            for chunk in self.chunks:
                if self.hold is not None:
                    await self.hold.wait()
                yield chunk
        finally:
            await asyncio.sleep(self.cleanup_delay)   # e.g. waiting for the model to go idle
            self.cleanup_done = True

    async def status(self):
        return VisionStatus(enabled=True, loaded=False, busy=False, idle_seconds=None, model="fake")

    async def start(self):
        pass

    async def stop(self):
        self.stopped = True


def make(port=None, **cfg):
    clock = type("Clock", (), {"t": 1000.0, "__call__": lambda self: self.t})()
    port = port or FakePort()
    return VisionService(port, VisionConfig(**cfg), clock=clock), port, clock


async def collect(stream) -> str:
    parts = []
    try:
        async for chunk in stream:
            parts.append(chunk)
    finally:
        await stream.aclose()
    return "".join(parts)


# ---------- photos ----------

def test_a_large_photo_is_shrunk_and_stored():
    svc, _, _ = make(image_max_edge_px=1024, upload_max_bytes=10_000_000)
    info = run(svc.store_image(jpeg((3000, 2000))))
    assert (info.width, info.height) == (1024, 683) and info.image_id


def test_small_photo_is_not_enlarged():
    svc, _, _ = make()
    assert (lambda i: (i.width, i.height))(run(svc.store_image(jpeg((400, 300))))) == (400, 300)


def test_exif_rotation_is_applied():
    exif = Image.Exif()
    exif[0x0112] = 6   # rotate 90 degrees to display
    svc, port, _ = make()
    info = run(svc.store_image(jpeg((200, 100), exif=exif.tobytes())))
    assert (info.width, info.height) == (100, 200)


def test_location_and_camera_metadata_are_dropped():
    exif = Image.Exif()
    exif[0x010F] = "SecretCameraCo"   # Make
    exif[0x8825] = {1: "N", 2: (17.0, 22.0, 0.0)}   # GPS block
    original = jpeg(exif=exif.tobytes())
    assert b"SecretCameraCo" in original
    svc, port, _ = make()
    info = run(svc.store_image(original))

    async def go():
        stream = await svc.ask(info.image_id)
        await collect(stream)

    run(go())
    sent = port.calls[0][0]
    assert b"SecretCameraCo" not in sent and len(Image.open(io.BytesIO(sent)).getexif()) == 0


def test_png_with_transparency_is_flattened_to_white():
    buf = io.BytesIO()
    Image.new("RGBA", (50, 50), (0, 0, 0, 0)).save(buf, "PNG")
    svc, port, _ = make()
    info = run(svc.store_image(buf.getvalue()))

    async def go():
        await collect(await svc.ask(info.image_id))

    run(go())
    pixel = Image.open(io.BytesIO(port.calls[0][0])).getpixel((10, 10))
    assert min(pixel) > 240   # white, not black


def test_webp_is_accepted():
    svc, _, _ = make()
    assert run(svc.store_image(jpeg(fmt="WEBP"))).image_id


@pytest.mark.parametrize("data", [b"", b"not an image at all", b"GIF89a" + b"\x00" * 40])
def test_unusable_uploads_are_rejected(data):
    svc, _, _ = make()
    with pytest.raises(AppException) as e:
        run(svc.store_image(data))
    assert e.value.code == ExceptionCode.IMAGE_INVALID


def test_gif_is_not_a_supported_format():
    buf = io.BytesIO()
    Image.new("P", (20, 20)).save(buf, "GIF")
    svc, _, _ = make()
    with pytest.raises(AppException) as e:
        run(svc.store_image(buf.getvalue()))
    assert e.value.code == ExceptionCode.IMAGE_INVALID


def test_oversize_upload_is_rejected_before_decoding():
    svc, _, _ = make(upload_max_bytes=1000)
    with pytest.raises(AppException) as e:
        run(svc.store_image(jpeg((600, 600))))
    assert e.value.code == ExceptionCode.IMAGE_INVALID and "KB" in e.value.message


def test_a_small_file_that_expands_into_a_huge_image_is_rejected():
    buf = io.BytesIO()
    Image.new("1", (7000, 7001), 1).save(buf, "PNG")   # ~49 million pixels, tiny on disk
    assert len(buf.getvalue()) < 200_000
    svc, _, _ = make(upload_max_bytes=1_048_576)
    with pytest.raises(AppException) as e:
        run(svc.store_image(buf.getvalue()))
    assert e.value.code == ExceptionCode.IMAGE_INVALID and "too large" in e.value.message


# ---------- cache ----------

def test_only_the_newest_photos_are_kept():
    svc, _, clock = make(image_cache_max=3)
    ids = []
    for _ in range(4):
        ids.append(run(svc.store_image(jpeg())).image_id)
        clock.t += 1
    with pytest.raises(AppException):
        run(svc.ask(ids[0]))
    assert run(svc.ask(ids[3]))   # newest is still there


def test_photos_expire():
    svc, _, clock = make(image_cache_ttl_s=300)
    image_id = run(svc.store_image(jpeg())).image_id
    clock.t += 301
    with pytest.raises(AppException) as e:
        run(svc.ask(image_id))
    assert e.value.code == ExceptionCode.IMAGE_INVALID


def test_unknown_photo_id():
    svc, _, _ = make()
    with pytest.raises(AppException) as e:
        run(svc.ask("nope"))
    assert e.value.code == ExceptionCode.IMAGE_INVALID


def test_stop_clears_photos_and_stops_the_backend():
    svc, port, _ = make()
    image_id = run(svc.store_image(jpeg())).image_id
    run(svc.stop())
    assert port.stopped
    with pytest.raises(AppException):
        run(svc.ask(image_id))


# ---------- asking ----------

def test_reply_streams_and_the_backend_gets_the_photo_and_a_describe_prompt():
    svc, port, _ = make()

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        return await collect(await svc.ask(image_id))

    assert run(go()) == "A red apple."
    image, mime, prompt = port.calls[0]
    assert mime == "image/jpeg" and Image.open(io.BytesIO(image)).format == "JPEG"
    assert prompt == STYLE_PROMPTS["brief"]


def test_a_follow_up_question_reuses_the_stored_photo():
    svc, port, _ = make(port=FakePort(chunks=["Yes."]))

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        await collect(await svc.ask(image_id))
        await collect(await svc.ask(image_id, question="  Is the apple ripe?  "))

    run(go())
    assert len(port.calls) == 2 and port.calls[0][0] == port.calls[1][0]   # same bytes, no re-upload
    assert "Is the apple ripe?" in port.calls[1][2] and "cannot tell" in port.calls[1][2]


def test_overlong_questions_are_cut():
    svc, port, _ = make()

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        await collect(await svc.ask(image_id, question="x" * 5000))

    run(go())
    assert "x" * 301 not in port.calls[0][2]


@pytest.mark.parametrize("kwargs", [{"lang": "hi"}, {"lang": "te"}, {"style": "poetic"}])
def test_unsupported_language_or_style_is_a_validation_error(kwargs):
    svc, _, _ = make()
    image_id = run(svc.store_image(jpeg())).image_id
    with pytest.raises(AppException) as e:
        run(svc.ask(image_id, **kwargs))
    assert e.value.code == ExceptionCode.VALIDATION_ERROR


def test_markdown_in_the_reply_is_removed():
    svc, _, _ = make(port=FakePort(chunks=["**A red** apple\n", "- on a ", "`table`.\n\n", "1. It looks ripe."]))

    async def go():
        return await collect(await svc.ask((await svc.store_image(jpeg())).image_id))

    assert run(go()) == "A red apple on a table. It looks ripe."


# ---------- one photo at a time ----------

def test_a_second_request_while_one_is_running_is_busy():
    hold = asyncio.Event()
    svc, port, _ = make(port=FakePort(hold=hold))

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        first = await svc.ask(image_id)
        with pytest.raises(AppException) as e:
            await svc.ask(image_id)
        assert e.value.code == ExceptionCode.VISION_BUSY
        hold.set()
        assert await collect(first) == "A red apple."
        assert await collect(await svc.ask(image_id)) == "A red apple."   # free again

    run(go())


def test_the_slot_is_reserved_before_streaming_starts():
    """The route must be able to answer 429 before it sends stream headers."""
    svc, _, _ = make()

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        first = await svc.ask(image_id)   # never iterated yet
        with pytest.raises(AppException) as e:
            await svc.ask(image_id)
        assert e.value.code == ExceptionCode.VISION_BUSY
        await first.aclose()
        await svc.ask(image_id)   # closing an unstarted stream frees the slot

    run(go())


def test_a_reservation_that_never_starts_is_taken_back_after_the_lease():
    svc, _, clock = make()

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        await svc.ask(image_id)   # reserved, then the client vanished: never iterated, never closed
        clock.t += 5
        with pytest.raises(AppException):
            await svc.ask(image_id)   # still within the lease
        clock.t += 11
        assert await collect(await svc.ask(image_id)) == "A red apple."   # taken back

    run(go())


def test_a_started_stream_is_never_taken_back_however_long_it_runs():
    hold = asyncio.Event()
    svc, _, clock = make(port=FakePort(hold=hold), image_cache_ttl_s=1_000_000)   # the photo must outlive the fake hours

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        first = await svc.ask(image_id)
        waiter = asyncio.ensure_future(first.__anext__())
        await asyncio.sleep(0)   # the stream has started
        clock.t += 10_000
        with pytest.raises(AppException) as e:
            await svc.ask(image_id)
        assert e.value.code == ExceptionCode.VISION_BUSY
        hold.set()
        await waiter
        await first.aclose()

    run(go())


def test_a_taken_back_stream_closing_late_does_not_free_the_new_ones_slot():
    svc, _, clock = make()

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        stale = await svc.ask(image_id)
        clock.t += 16
        fresh = await svc.ask(image_id)   # took the slot back from `stale`
        await stale.aclose()              # ...which now closes late
        with pytest.raises(AppException) as e:
            await svc.ask(image_id)       # the slot still belongs to `fresh`
        assert e.value.code == ExceptionCode.VISION_BUSY
        await fresh.aclose()
        await svc.ask(image_id)

    run(go())


def test_a_rejected_request_does_not_take_the_slot():
    svc, _, _ = make()

    async def go():
        with pytest.raises(AppException):
            await svc.ask("missing")
        with pytest.raises(AppException):
            await svc.ask("missing", lang="hi")
        image_id = (await svc.store_image(jpeg())).image_id
        assert await collect(await svc.ask(image_id))

    run(go())


def test_the_slot_is_freed_only_after_the_backend_has_finished_cleaning_up():
    """A cancelled photo must not let a new one start while the model is still busy with the old one."""
    port = FakePort(cleanup_delay=0.05)
    svc, _, _ = make(port=port)

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        stream = await svc.ask(image_id)
        await stream.__anext__()
        await stream.aclose()
        assert port.cleanup_done   # aclose waited for it
        await svc.ask(image_id)    # and only then was the slot free

    run(go())


def test_cancel_stops_the_stream_early():
    cancel = asyncio.Event()
    svc, port, _ = make(port=FakePort(chunks=["one ", "two ", "three "]))

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        stream = await svc.ask(image_id, cancel=cancel)
        got = [await stream.__anext__()]
        cancel.set()
        async for chunk in stream:
            got.append(chunk)
        await stream.aclose()
        return got

    assert run(go()) == ["one "]
    assert port.cleanup_done


# ---------- failures stay inside vision ----------

def test_backend_crash_becomes_a_vision_error_and_frees_the_slot():
    svc, _, _ = make(port=FakePort(error=RuntimeError("segfault at 0x0 /secret/path")))

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        with pytest.raises(AppException) as e:
            await collect(await svc.ask(image_id))
        assert e.value.code == ExceptionCode.VISION_UNAVAILABLE
        assert "secret" not in e.value.message   # internals are not leaked to the phone
        svc._port.error = None
        assert await collect(await svc.ask(image_id))

    run(go())


def test_backend_app_errors_pass_through_unchanged():
    err = AppException("adapter", ExceptionCode.VISION_UNAVAILABLE, message="not enough free memory to load the model")
    svc, _, _ = make(port=FakePort(error=err))

    async def go():
        image_id = (await svc.store_image(jpeg())).image_id
        with pytest.raises(AppException) as e:
            await collect(await svc.ask(image_id))
        assert e.value.message == "not enough free memory to load the model"

    run(go())


# ---------- the speech cleaner ----------

def clean(*chunks) -> str:
    c = SpeechCleaner()
    return "".join(c.feed(x) for x in chunks) + c.flush()


@pytest.mark.parametrize("raw,expected", [
    ("**bold** and `code`", "bold and code"),
    ("# Heading\nText", "Heading Text"),
    ("- one\n- two", "one two"),
    ("* one\n* two", "one two"),
    ("1. first\n2. second", "first second"),
    ("3) third", "third"),
    ("It is -5 degrees", "It is -5 degrees"),
    ("-5 degrees outside", "-5 degrees outside"),
    ("12.5 percent", "12.5 percent"),
    ("10 apples", "10 apples"),
    ("A  lot   of   space", "A lot of space"),
    ("two\n\n\nparagraphs", "two paragraphs"),
    ("", ""),
])
def test_cleaner(raw, expected):
    assert clean(raw).strip() == expected


def test_cleaner_gives_the_same_result_however_the_stream_is_cut():
    raw = "**A red** apple.\n- on a table\n1. and a mug\nIt is -5 degrees, 12.5 percent."
    whole = clean(raw)
    assert clean(*raw) == whole   # one character at a time
    assert clean(raw[:7], raw[7:30], raw[30:]) == whole
