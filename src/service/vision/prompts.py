"""The questions put to the vision model. The reply is read aloud, so every prompt asks for plain spoken English."""

from __future__ import annotations

_SPOKEN = "Plain spoken English, no lists, no markdown, no emoji."

STYLE_PROMPTS = {
    "brief": f"Describe this image in two short sentences for someone who cannot see it. {_SPOKEN}",
    "detailed": (
        "Describe this image for someone who cannot see it: the main subject, what is around it, colours, and any "
        f"text you can read. Use at most six short sentences. {_SPOKEN}"
    ),
    "read_text": (
        "Read out all the text visible in this image exactly as written, in reading order. "
        "If there is no readable text, say so. No markdown."
    ),
}

QUESTION_PROMPT = (
    "Look at this image and answer the question in one or two short sentences. If the image does not show the "
    f"answer, say you cannot tell. {_SPOKEN}\nQuestion: {{question}}"
)

QUESTION_MAX_CHARS = 300


def build_prompt(style: str, question: str | None) -> str:
    """The question wins over the style: asking something about a photo is a different task than describing it."""
    question = (question or "").strip()[:QUESTION_MAX_CHARS]
    if question:
        return QUESTION_PROMPT.format(question=question)
    return STYLE_PROMPTS[style]
