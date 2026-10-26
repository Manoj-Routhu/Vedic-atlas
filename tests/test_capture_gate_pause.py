from service.privacy.capture_gate import CaptureGate


class _MuteSwitch:
    source_name = "test"

    def __init__(self):
        self.muted = False
        self.callback = None

    def subscribe(self, callback):
        self.callback = callback

    def is_muted(self):
        return self.muted

    def sync_state(self, muted):
        self.muted = muted


class _Audio:
    def __init__(self):
        self.starts = 0
        self.stops = 0

    def start(self):
        self.starts += 1

    def stop(self):
        self.stops += 1


def test_capture_pause_preserves_privacy_mute_and_defers_reopening():
    switch = _MuteSwitch()
    audio = _Audio()
    gate = CaptureGate(switch, audio=audio)
    gate.start()

    assert audio.starts == 1
    gate.pause_capture()
    assert gate.is_muted() is False
    assert audio.stops == 1

    gate.set_muted(True, source="user")
    gate.set_muted(False, source="user")
    assert gate.is_muted() is False
    assert audio.starts == 1

    assert gate.resume_capture() is True
    assert audio.starts == 2
    assert gate.resume_capture() is True
    assert audio.starts == 2


def test_capture_pause_does_not_override_user_mute():
    switch = _MuteSwitch()
    audio = _Audio()
    gate = CaptureGate(switch, audio=audio)
    gate.start()
    gate.pause_capture()
    gate.set_muted(True, source="user")

    assert gate.resume_capture() is False
    assert gate.is_muted() is True
    assert audio.starts == 1


# ---- several holders (a voice turn and music) and mute listeners (docs/13) -----------------------------------------------------

def test_the_mic_reopens_only_when_every_holder_has_let_go():
    switch, audio = _MuteSwitch(), _Audio()
    gate = CaptureGate(switch, audio=audio)
    gate.start()
    gate.pause_capture("voice_turn:1")
    gate.pause_capture("music")
    assert audio.stops == 1                                    # stopped once, by the first holder
    assert gate.resume_capture("voice_turn:1") is False        # the turn ended, music still holds it
    assert audio.starts == 1
    assert gate.resume_capture("music") is True
    assert audio.starts == 2
    assert gate.resume_capture("music") is True and audio.starts == 2   # releasing twice changes nothing


def test_a_holder_released_while_muted_leaves_the_mic_closed_until_unmute():
    switch, audio = _MuteSwitch(), _Audio()
    gate = CaptureGate(switch, audio=audio)
    gate.start()
    gate.pause_capture("music")
    gate.set_muted(True, source="user")
    assert gate.resume_capture("music") is False and audio.starts == 1
    gate.set_muted(False, source="user")
    assert audio.starts == 2 and gate.is_muted() is False


def test_mute_listeners_hear_every_change_from_the_switch_and_from_the_api_and_never_block_the_gate():
    switch, audio = _MuteSwitch(), _Audio()
    gate = CaptureGate(switch, audio=audio)
    heard = []

    def broken(muted):
        raise RuntimeError("listener bug")

    gate.start()                                   # adopting the switch's state at startup is not a change the user made
    gate.add_mute_listener(broken)
    gate.add_mute_listener(heard.append)
    gate.set_muted(True, source="api")
    gate.set_muted(False, source="api")
    switch.callback(__import__("domain.events.capture_event", fromlist=["CaptureEvent"]).CaptureEvent(
        muted=True, previous_muted=False, source="test",
        changed_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc)))
    assert heard == [True, False, True]
