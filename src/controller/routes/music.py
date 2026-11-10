"""Music HTTP API - the phone as the remote control. The sound comes from the device's own speaker (mpv), never the phone.

  GET  /api/music/status   {available, reason, state, title, elapsed_s, limit_s, duration_s}   (works when music is off)
  POST /api/music/play     {query}  -> status (state "starting": the song begins once Veda has stopped talking)
  POST /api/music/stop     -> status
  POST /api/music/pause    -> status   (409 when no song is playing)
  POST /api/music/resume   -> status   (409 when no song is playing)
  POST /api/music/seek     {position_s} -> status   (409 when nothing plays or the length is unknown; 502 if the player balks)

Every call needs the phone's control permission. The microphone is closed while a song plays and a mute or unmute stops it
(service/music/music_service.py); none of that is changed or bypassed here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from controller.dependencies.providers import get_music_service
from core.enums import ErrorMessage, ExceptionCode
from domain.ports.music_ports import MusicError
from exceptions.exception import AppException
from schemas.music import MusicStatusResponse, PlayRequest, SeekRequest
from service.music.music_service import MusicService

router = APIRouter()


def _snapshot(music: MusicService) -> MusicStatusResponse:
    s = music.status()
    return MusicStatusResponse(
        available=True, state=s.state, title=s.title, elapsed_s=s.elapsed_s, limit_s=s.limit_s, duration_s=s.duration_s,
        seekable=s.seekable,
    )


@router.get("/music/status", response_model=MusicStatusResponse)
async def music_status(request: Request) -> MusicStatusResponse:
    music = getattr(request.app.state, "music", None)
    if music is None:
        reason = getattr(request.app.state, "music_off_reason", None) or "off"
        return MusicStatusResponse(available=False, reason=reason)
    return _snapshot(music)


@router.post("/music/play", response_model=MusicStatusResponse)
async def music_play(body: PlayRequest, music: MusicService = Depends(get_music_service)) -> MusicStatusResponse:
    try:
        await music.play(body.query)
    except MusicError as e:   # nothing matched, or the search failed: `spoken` is a sentence fit for the screen
        raise AppException("music", ExceptionCode.MUSIC_NOT_FOUND, ErrorMessage.MUSIC_NOT_FOUND, detail=e.spoken) from e
    return _snapshot(music)


@router.post("/music/stop", response_model=MusicStatusResponse)
async def music_stop(music: MusicService = Depends(get_music_service)) -> MusicStatusResponse:
    await music.stop("asked from the phone")
    return _snapshot(music)


@router.post("/music/pause", response_model=MusicStatusResponse)
async def music_pause(music: MusicService = Depends(get_music_service)) -> MusicStatusResponse:
    if not await music.pause_by_user():
        raise AppException("music", ExceptionCode.MUSIC_NOT_PLAYING, ErrorMessage.MUSIC_NOT_PLAYING)
    return _snapshot(music)


@router.post("/music/resume", response_model=MusicStatusResponse)
async def music_resume(music: MusicService = Depends(get_music_service)) -> MusicStatusResponse:
    if not await music.resume_by_user():
        raise AppException("music", ExceptionCode.MUSIC_NOT_PLAYING, ErrorMessage.MUSIC_NOT_PLAYING)
    return _snapshot(music)


@router.post("/music/seek", response_model=MusicStatusResponse)
async def music_seek(body: SeekRequest, music: MusicService = Depends(get_music_service)) -> MusicStatusResponse:
    if not music.active or not music.is_playing:   # idle or still starting: nothing to jump in yet
        raise AppException("music", ExceptionCode.MUSIC_NOT_PLAYING, ErrorMessage.MUSIC_NOT_PLAYING)
    try:
        moved = await music.seek(body.position_s)
    except MusicError as e:
        raise AppException("music", ExceptionCode.MUSIC_SEEK_FAILED, ErrorMessage.MUSIC_SEEK_FAILED, detail=e.spoken) from e
    if not moved:
        raise AppException("music", ExceptionCode.MUSIC_NOT_SEEKABLE, ErrorMessage.MUSIC_NOT_SEEKABLE)
    return _snapshot(music)
