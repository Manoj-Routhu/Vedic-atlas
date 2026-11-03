"""Generate a synthetic 2,500-example control/router dataset.

Classes = the 18 real tools + `chat` + `clarify` (20 decision classes).
Counts:
  1000 TP = 18 tools x 50 tool-call cases + 50 chat + 50 clarify
  500 FP  = "mention but do not call" cases spread over the tools
  500 TN  = no-tool decisions (chat, clarify, refuse)
  500 FN  = implicit tool requests spread over the tools

Output: training/datasets/control_20skills_2500.jsonl, in the Sample format used by training.build.
Templates are synthetic; review a random 100 before training. All people/addresses are fake.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from training.sample import Sample, dump  # noqa: E402
from training.validate import validate  # noqa: E402

LANGS = ["English", "Hindi", "Telugu", "German"]
SUFFIX = {
    "English": ["", " please", " now", " for me"],
    "Hindi": ["", " कृपया", " अभी", " मेरे लिए"],
    "Telugu": ["", " దయచేసి", " ఇప్పుడు", " నా కోసం"],
    "German": ["", " bitte", " jetzt", " für mich"],
}
PLACES = ["Hyderabad", "Mumbai", "Delhi", "Chennai", "Bengaluru", "Pune", "Tokyo", "Beijing", "Berlin", "Paris"]
CURRENCIES = [
    ("USD", "INR", 100), ("EUR", "INR", 50), ("USD", "EUR", 250), ("GBP", "INR", 75),
    ("INR", "USD", 500), ("EUR", "GBP", 42), ("USD", "JPY", 1000), ("AUD", "INR", 30),
    ("CAD", "USD", 80), ("CHF", "EUR", 60),
]
APPS = ["spotify", "chrome", "notepad", "vscode", "calculator", "whatsapp", "slack", "terminal", "files", "photos"]
TASKS = ["buy milk", "call mom", "pay rent", "submit report", "book dentist", "renew passport", "clean kitchen", "water plants", "send invoice", "fix bike"]
PEOPLE = ["Priya", "Ravi", "Asha", "Karan", "Meera", "Arjun", "Sneha", "Vikram", "Nisha", "Rahul"]
SUBJECTS = ["invoice", "project update", "meeting notes", "report", "travel plan", "birthday", "budget", "schedule"]
SONGS = ["Tum Hi Ho", "Believer", "Kesariya", "Shape of You", "Raataan Lambiyan", "Blinding Lights", "Channa Mereya", "Levitating", "Apna Bana Le", "Perfect"]
ARTISTS = ["Arijit Singh", "Ed Sheeran", "Atif Aslam", "Taylor Swift", "Pritam", "Dua Lipa"]
SEARCHES = [
    ("ISRO latest news", "news"), ("score of yesterday's match", "news"), ("price of bitcoin", "general"),
    ("current prime minister of japan", "general"), ("latest iphone price", "general"), ("news about sri lanka", "news"),
    ("who won the election in brazil", "news"), ("stock price of infosys", "general"),
]
ADVISE_WORDS = ("umbrella", "jacket", "should i", "do i need", "am i free", "too hot", "open a window",
                "छाता", "जैकेट", "గొడుగు", "జాకెట్", "regenschirm", "jacke")


def with_suffix(text: str, suffix: str) -> str:
    if not suffix:
        return text
    return (text[:-1] + suffix + "?") if text.endswith("?") else (text + suffix)


def place() -> list[dict]:
    return [{"place": p} for p in PLACES]


def grp(patterns: dict[str, list[str]], values: list[dict], count: int, *, advise: bool = False) -> dict:
    return {"patterns": patterns, "values": values, "count": count, "advise": advise}


TP: dict[str, list[dict]] = {
    "get_weather": [grp({
        "English": ["what's the weather in {place}", "weather in {place}", "is it hot in {place}"],
        "Hindi": ["{place} में मौसम कैसा है", "{place} का मौसम बताओ", "{place} में गर्मी है क्या"],
        "Telugu": ["{place}లో వాతావరణం ఎలా ఉంది", "{place}లో వాతావరణం చెప్పండి", "{place}లో వేడిగా ఉందా"],
        "German": ["wie ist das wetter in {place}", "wetter in {place}", "ist es heiß in {place}"],
    }, place(), 50)],
    "get_weather_forecast": [grp({
        "English": ["will it rain {when} in {place}", "forecast for {place} {when}", "weather in {place} {when}"],
        "Hindi": ["{when} {place} में बारिश होगी क्या", "{place} का {when} का मौसम बताओ"],
        "Telugu": ["{when} {place}లో వర్షం పడుతుందా", "{place} {when} వాతావరణం చెప్పండి"],
        "German": ["regnet es {when} in {place}", "wetter in {place} {when}"],
    }, [{"place": p, "date_offset": o, "when": w} for p in PLACES[:8] for o, w in ((1, "tomorrow"), (2, "the day after tomorrow"), (0, "today"))], 50)],
    "convert_currency": [grp({
        "English": ["convert {amount} {from} to {to}", "how much is {amount} {from} in {to}", "{amount} {from} in {to}"],
        "Hindi": ["{amount} {from} को {to} में बदलो", "{amount} {from} {to} में कितने होंगे"],
        "Telugu": ["{amount} {from} ను {to} లోకి మార్చండి", "{amount} {from} {to} లో ఎంత"],
        "German": ["rechne {amount} {from} in {to} um", "wie viel sind {amount} {from} in {to}"],
    }, [{"amount": a, "from": f, "to": t} for f, t, a in CURRENCIES], 50)],
    "web_search": [grp({
        "English": ["search for {query}", "what's the latest on {query}", "look up {query}"],
        "Hindi": ["{query} खोजो", "{query} के बारे में ताज़ा खबर बताओ"],
        "Telugu": ["{query} వెతకండి", "{query} గురించి తాజా వార్తలు చెప్పండి"],
        "German": ["suche nach {query}", "was gibt es neues über {query}"],
    }, [{"query": q, "topic": t} for q, t in SEARCHES], 50)],
    "tasks": [
        grp({"English": ["add {title} to my tasks", "remind me to {title}", "put {title} on my list"],
             "Hindi": ["{title} को मेरे टास्क में जोड़ो", "मुझे {title} याद दिलाओ"],
             "Telugu": ["{title} నా టాస్క్‌లలో జోడించండి", "{title} గుర్తు చేయండి"],
             "German": ["füge {title} zu meinen aufgaben hinzu", "erinnere mich an {title}"]},
            [{"action": "add", "title": t} for t in TASKS], 20),
        grp({"English": ["what are my tasks", "show my to-do list", "what's pending"],
             "Hindi": ["मेरे टास्क क्या हैं", "मेरी टू-डू लिस्ट दिखाओ"],
             "Telugu": ["నా టాస్క్‌లు ఏమిటి", "నా టు-డు లిస్ట్ చూపించండి"],
             "German": ["was sind meine aufgaben", "zeig mir meine liste"]},
            [{"action": "list", "flavor": f} for f in ("", "today", "all", "pending", "now")], 10),
        grp({"English": ["i finished {title}", "mark {title} done", "complete {title}"],
             "Hindi": ["मैंने {title} पूरा कर लिया", "{title} को पूरा मार्क करो"],
             "Telugu": ["{title} పూర్తి చేశాను", "{title} పూర్తయిందని గుర్తించండి"],
             "German": ["ich habe {title} erledigt", "markiere {title} als erledigt"]},
            [{"action": "complete", "title": t} for t in TASKS], 10),
        grp({"English": ["remove {title} from my tasks", "delete the {title} task"],
             "Hindi": ["{title} को मेरे टास्क से हटाओ", "{title} टास्क डिलीट करो"],
             "Telugu": ["{title} నా టాస్క్‌ల నుండి తీసేయండి", "{title} టాస్క్ తొలగించండి"],
             "German": ["entferne {title} aus meinen aufgaben", "lösche die aufgabe {title}"]},
            [{"action": "delete", "title": t} for t in TASKS], 10),
    ],
    "remember": [
        grp({"English": ["my favourite sweet is {value}", "remember that my favourite sweet is {value}"],
             "Hindi": ["मेरी पसंदीदा मिठाई {value} है", "याद रखना मेरी पसंदीदा मिठाई {value} है"],
             "Telugu": ["నాకు ఇష్టమైన స్వీట్ {value}", "నా ఇష్టమైన స్వీట్ {value} అని గుర్తుపెట్టుకో"],
             "German": ["meine lieblingssüßigkeit ist {value}", "merk dir meine lieblingssüßigkeit ist {value}"]},
            [{"action": "save", "topic": "favourite sweet", "value": v} for v in ("gulab jamun", "jalebi", "rasgulla", "kaju katli", "laddu")], 25),
        grp({"English": ["forget my {topic}", "forget that my {topic} is gulab jamun"],
             "Hindi": ["मेरा {topic} भूल जाओ", "याद रखना मेरा {topic} भूल जाओ"],
             "Telugu": ["నా {topic} మర్చిపో", "నా {topic} గుర్తుంచుకోకు"],
             "German": ["vergiss mein {topic}", "vergiss mein {topic} bitte"]},
            [{"action": "forget", "topic": "favourite sweet", "flavor": f} for f in ("", "now", "please")], 10),
        grp({"English": ["what do you remember about me", "what do you know about me"],
             "Hindi": ["मेरे बारे में तुम्हें क्या याद है"],
             "Telugu": ["నా గురించి నీకు ఏమి గుర్తుంది"],
             "German": ["was erinnerst du dich über mich"]},
            [{"action": "list", "flavor": f} for f in ("", "today", "so far", "now", "please")], 15),
    ],
    "app_control": [
        grp({"English": ["open {name}", "launch {name}"],
             "Hindi": ["{name} खोलो", "{name} चालू करो"],
             "Telugu": ["{name} తెరవండి", "{name} ప్రారంభించండి"],
             "German": ["öffne {name}", "starte {name}"]},
            [{"action": "open", "name": n} for n in APPS], 20),
        grp({"English": ["close {name}", "shut {name} down"],
             "Hindi": ["{name} बंद करो", "{name} बंद कर दो"],
             "Telugu": ["{name} మూసేయండి", "{name} ఆపండి"],
             "German": ["schließe {name}", "beende {name}"]},
            [{"action": "close", "name": n} for n in APPS], 15),
        grp({"English": ["switch to {name}", "focus {name}", "bring {name} to the front"],
             "Hindi": ["{name} पर स्विच करो", "{name} सामने लाओ"],
             "Telugu": ["{name} కి మారండి", "{name} ముందుకు తీసుకురండి"],
             "German": ["wechsle zu {name}", "bringe {name} nach vorne"]},
            [{"action": "focus", "name": n} for n in APPS], 15),
    ],
    "volume_control": [
        grp({"English": ["set the volume to {level}", "turn the volume to {level}"],
             "Hindi": ["वॉल्यूम {level} करो", "आवाज़ {level} पर सेट करो"],
             "Telugu": ["వాల్యూమ్ {level} కి సెట్ చేయండి", "శబ్దం {level} కి పెంచండి"],
             "German": ["stelle die lautstärke auf {level}", "setze die lautstärke auf {level}"]},
            [{"action": "set", "level": n} for n in (10, 20, 30, 40, 50, 60, 70, 80, 90, 25)], 20),
        grp({"English": ["what's the volume", "how loud is it"],
             "Hindi": ["वॉल्यूम कितना है", "आवाज़ कितनी है"],
             "Telugu": ["వాల్యూమ్ ఎంత ఉంది", "శబ్దం ఎంత ఉంది"],
             "German": ["wie laut ist es", "wie ist die lautstärke"]},
            [{"action": "get", "flavor": f} for f in ("", "now", "today", "please", "for me")], 10),
        grp({"English": ["mute the speaker", "mute the volume", "silence it"],
             "Hindi": ["स्पीकर म्यूट करो", "आवाज़ बंद करो"],
             "Telugu": ["స్పీకర్ మ్యూట్ చేయండి", "శబ్దం ఆపండి"],
             "German": ["stummschalten", "schalte den ton stumm"]},
            [{"action": "mute", "flavor": f} for f in ("", "now", "please", "for me", "right now")], 10),
        grp({"English": ["unmute the speaker", "turn the sound back on"],
             "Hindi": ["स्पीकर अनम्यूट करो", "आवाज़ फिर से चालू करो"],
             "Telugu": ["స్పీకర్ అన్‌మ్యూట్ చేయండి", "శబ్దం మళ్లీ ఆన్ చేయండి"],
             "German": ["ton wieder an", "stummschaltung aufheben"]},
            [{"action": "unmute", "flavor": f} for f in ("", "now", "please", "for me", "right now")], 10),
    ],
    "device_status": [
        grp({"English": ["how much battery is left", "what's my battery", "battery level"],
             "Hindi": ["बैटरी कितनी बची है", "मेरी बैटरी कितनी है"],
             "Telugu": ["బ్యాటరీ ఎంత మిగిలింది", "నా బ్యాటరీ ఎంత ఉంది"],
             "German": ["wie viel akku ist übrig", "wie ist der akkustand"]},
            [{"what": "battery", "flavor": f} for f in ("", "now", "today", "please", "for me", "right now", "at the moment", "currently", "so far", "exactly")], 30),
        grp({"English": ["which apps are using cpu", "busiest processes", "what's running heavily"],
             "Hindi": ["कौन से ऐप्स सीपीयू ले रहे हैं", "सबसे भारी प्रोसेस कौन सी है"],
             "Telugu": ["ఏ యాప్‌లు సీపీయూ వాడుతున్నాయి", "అత్యధిక ప్రాసెస్ ఏది"],
             "German": ["welche apps nutzen die cpu", "welche prozesse laufen stark"]},
            [{"what": "processes", "flavor": f} for f in ("", "now", "today", "please", "for me", "right now")], 20),
    ],
    "gmail_search": [
        grp({"English": ["check my inbox", "any new mail", "show my unread emails"],
             "Hindi": ["मेरा इनबॉक्स देखो", "कोई नया मेल है क्या"],
             "Telugu": ["నా ఇన్‌బాక్స్ చూడండి", "కొత్త మెయిల్ ఉందా"],
             "German": ["schau in meinen posteingang", "gibt es neue mail"]},
            [{"unread_only": True, "flavor": f} for f in ("", "now", "today", "please", "for me")], 15),
        grp({"English": ["any mail from {name}", "did {name} email me", "mail from {name} today"],
             "Hindi": ["{name} का कोई मेल है क्या", "{name} ने मेल भेजा क्या"],
             "Telugu": ["{name} నుండి మెయిల్ ఉందా", "{name} మెయిల్ పంపారా"],
             "German": ["gibt es mail von {name}", "hat {name} mir geschrieben"]},
            [{"query": f"from:{n.lower()} newer_than:1d", "name": n, "flavor": f} for n in PEOPLE for f in ("", "now", "today")], 15),
        grp({"English": ["what mail did i send to {name}", "show sent mail to {name}"],
             "Hindi": ["मैंने {name} को क्या मेल भेजा", "{name} को भेजा मेल दिखाओ"],
             "Telugu": ["నేను {name} కి పంపిన మెయిల్ చూపించండి"],
             "German": ["welche mail habe ich an {name} gesendet"]},
            [{"query": f"to:{n.lower()}", "folder": "sent", "name": n, "flavor": f} for n in PEOPLE for f in ("", "now", "today")], 10),
        grp({"English": ["any mail about {subject}", "mail with subject {subject}"],
             "Hindi": ["{subject} के बारे में मेल है क्या"],
             "Telugu": ["{subject} గురించి మెయిల్ ఉందా"],
             "German": ["gibt es mail zum thema {subject}"]},
            [{"query": f"subject:{s}", "subject": s, "flavor": f} for s in SUBJECTS for f in ("", "now", "today")], 10),
    ],
    "gmail_read": [grp({
        "English": ["read my last email from {name}", "what did {name} say", "read the mail from {name}"],
        "Hindi": ["{name} का आखिरी मेल पढ़ो", "{name} ने क्या लिखा"],
        "Telugu": ["{name} చివరి మెయిల్ చదవండి", "{name} ఏమి చెప్పారు"],
        "German": ["lies die letzte mail von {name}", "was hat {name} geschrieben"],
    }, [{"query": f"from:{n.lower()}", "name": n, "flavor": f} for n in PEOPLE for f in ("", "please", "now")], 50)],
    "gmail_draft": [grp({
        "English": ["email {to} that the {subject} is ready", "write an email to {to} about {subject}"],
        "Hindi": ["{to} को मेल लिखो कि {subject} तैयार है"],
        "Telugu": ["{to} కి మెయిల్ రాయండి, {subject} సిద్ధంగా ఉంది"],
        "German": ["schreibe {to} eine mail, dass {subject} fertig ist"],
    }, [{"to": n, "subject": s.title(), "body": f"Hi {n}, the {s} is ready.", "flavor": f}
        for n in PEOPLE for s in SUBJECTS for f in ("", "please")], 50)],
    "gmail_send": [grp({
        "English": ["send it", "ok send it", "send the draft", "go ahead and send it"],
        "Hindi": ["भेज दो", "ड्राफ्ट भेज दो", "हाँ भेज दो"],
        "Telugu": ["పంపండి", "డ్రాఫ్ట్ పంపండి", "సరే పంపండి"],
        "German": ["sende es", "schick den entwurf", "ja sende es"],
    }, [{"to": n, "subject": s.title(), "flavor": f} for n in PEOPLE for s in SUBJECTS for f in ("", "please")], 50)],
    "calendar_agenda": [
        grp({"English": ["what's on my calendar today", "any meetings today", "my agenda for today"],
             "Hindi": ["आज मेरे कैलेंडर पर क्या है", "आज कोई मीटिंग है क्या"],
             "Telugu": ["ఈరోజు నా క్యాలెండర్‌లో ఏమి ఉంది", "ఈరోజు మీటింగ్ ఉందా"],
             "German": ["was steht heute in meinem kalender", "habe ich heute meetings"]},
            [{"date_offset": 0, "flavor": f} for f in ("", "please", "now", "today", "for me")], 20),
        grp({"English": ["what's on my calendar tomorrow", "any meetings tomorrow"],
             "Hindi": ["कल मेरे कैलेंडर पर क्या है", "कल कोई मीटिंग है क्या"],
             "Telugu": ["రేపు నా క్యాలెండర్‌లో ఏమి ఉంది", "రేపు మీటింగ్ ఉందా"],
             "German": ["was steht morgen in meinem kalender", "habe ich morgen meetings"]},
            [{"date_offset": 1, "flavor": f} for f in ("", "please", "now", "for me", "early")], 15),
        grp({"English": ["what does my week look like", "show my calendar for the week"],
             "Hindi": ["मेरा हफ्ता कैसा है", "इस हफ्ते का कैलेंडर दिखाओ"],
             "Telugu": ["నా వారం ఎలా ఉంది", "ఈ వారం క్యాలెండర్ చూపించండి"],
             "German": ["wie sieht meine woche aus", "zeig meinen kalender für die woche"]},
            [{"date_offset": 0, "days": 7, "flavor": f} for f in ("", "please", "now", "for me", "ahead")], 15),
    ],
    "calendar_create": [grp({
        "English": ["put {title} on my calendar {when} at {time}", "schedule {title} {when} at {time}"],
        "Hindi": ["{when} {time} पर {title} कैलेंडर में डालो"],
        "Telugu": ["{when} {time} కి {title} క్యాలెండర్‌లో పెట్టండి"],
        "German": ["trag {title} {when} um {time} in den kalender ein"],
    }, [{"title": t, "date_offset": o, "time": tm, "when": w, "duration_minutes": d, "flavor": f}
        for t in ("Project kickoff", "Dentist", "Deep work", "Team sync", "Lunch with Priya",
                  "Gym", "Budget review", "Call mom", "Doctor", "Yoga")
        for o, w in ((0, "today"), (1, "tomorrow"))
        for tm, d, f in (("10:00", 60, ""), ("18:00", 120, "please"))], 50)],
    "current_time": [
        grp({"English": ["what time is it", "tell me the time", "what's the time now"],
             "Hindi": ["अभी क्या समय है", "समय बताओ"],
             "Telugu": ["ఇప్పుడు సమయం ఎంత", "సమయం చెప్పండి"],
             "German": ["wie spät ist es", "wie viel uhr ist es"]},
            [{"what": "time", "flavor": f} for f in ("", "please", "now", "exactly", "for me", "today", "at the moment")], 25),
        grp({"English": ["what's the date", "which day is it today", "what day is today"],
             "Hindi": ["आज कौन सी तारीख है", "आज कौन सा दिन है"],
             "Telugu": ["ఈరోజు తేదీ ఏమిటి", "ఈరోజు ఏ రోజు"],
             "German": ["welches datum ist heute", "welcher tag ist heute"]},
            [{"what": "date", "flavor": f} for f in ("", "please", "now", "exactly", "for me", "today", "at the moment")], 25),
    ],
    "music_control": [
        grp({"English": ["play {query}", "put on {query}", "play something by {query}"],
             "Hindi": ["{query} चलाओ", "{query} का कुछ चलाओ"],
             "Telugu": ["{query} ప్లే చేయండి", "{query} పాట వేయండి"],
             "German": ["spiele {query}", "spiele etwas von {query}"]},
            [{"action": "play", "query": s, "flavor": f} for s in SONGS for f in ("", "please")] +
            [{"action": "play", "query": a, "flavor": f} for a in ARTISTS for f in ("", "please")], 35),
        grp({"English": ["stop the music", "turn off the music", "stop playing"],
             "Hindi": ["संगीत बंद करो", "म्यूजिक बंद करो"],
             "Telugu": ["సంగీతం ఆపండి", "మ్యూజిక్ ఆపండి"],
             "German": ["stopp die musik", "schalte die musik aus"]},
            [{"action": "stop", "flavor": f} for f in ("", "please", "now", "for me", "right now")], 15),
    ],
    "get_room_temperature": [grp({
        "English": ["how hot is it in here", "what's the room temperature", "is it humid inside", "how cold is this room"],
        "Hindi": ["यहाँ कितनी गर्मी है", "कमरे का तापमान क्या है", "अंदर उमस है क्या"],
        "Telugu": ["ఇక్కడ ఎంత వేడిగా ఉంది", "గది ఉష్ణోగ్రత ఎంత", "లోపల తేమ ఉందా"],
        "German": ["wie heiß ist es hier", "wie ist die raumtemperatur", "ist es drinnen feucht"],
    }, [{"flavor": f} for f in ("", "please", "now", "today", "for me", "right now", "at the moment", "currently", "inside", "here")], 50)],
}

FN: dict[str, list[dict]] = {
    "get_weather": [grp({
        "English": ["do i need an umbrella in {place}", "is it going to rain in {place}", "should i carry a jacket in {place}"],
        "Hindi": ["{place} में छाता ले जाना चाहिए क्या", "{place} में बारिश होगी क्या"],
        "Telugu": ["{place}లో గొడుగు తీసుకెళ్లాలా", "{place}లో వర్షం పడుతుందా"],
        "German": ["brauche ich einen regenschirm in {place}", "regnet es in {place}"],
    }, place(), 27, advise=True)],
    "get_weather_forecast": [grp({
        "English": ["will it rain {when} in {place}", "do i need an umbrella {when} in {place}", "should i carry a jacket {when} in {place}"],
        "Hindi": ["{when} {place} में छाता चाहिए क्या", "{when} {place} में बारिश होगी क्या"],
        "Telugu": ["{when} {place}లో గొడుగు కావాలా", "{when} {place}లో వర్షం పడుతుందా"],
        "German": ["brauche ich {when} einen regenschirm in {place}", "regnet es {when} in {place}"],
    }, [{"place": p, "date_offset": o, "when": w} for p in PLACES[:8] for o, w in ((1, "tomorrow"), (2, "the day after tomorrow"), (0, "today"))], 27, advise=True)],
    "convert_currency": [grp({
        "English": ["what's {amount} {from} in {to}", "how much are {amount} {from} in {to}"],
        "Hindi": ["{amount} {from} {to} में कितने होंगे"],
        "Telugu": ["{amount} {from} {to} లో ఎంత"],
        "German": ["wie viel sind {amount} {from} in {to}"],
    }, [{"amount": a, "from": f, "to": t} for f, t, a in CURRENCIES], 27)],
    "web_search": [grp({
        "English": ["who won {query}", "what's the latest on {query}", "any news about {query}"],
        "Hindi": ["{query} के बारे में ताज़ा खबर क्या है"],
        "Telugu": ["{query} గురించి తాజా వార్తలు ఏమిటి"],
        "German": ["wer hat {query} gewonnen", "was gibt es neues über {query}"],
    }, [{"query": q, "topic": t} for q, t in SEARCHES], 27)],
    "tasks": [
        grp({"English": ["what do i have to do today", "what's left on my list", "anything pending"],
             "Hindi": ["आज मुझे क्या करना है", "मेरी लिस्ट में क्या बचा है"],
             "Telugu": ["ఈరోజు నేను ఏమి చేయాలి", "నా లిస్ట్‌లో ఏమి మిగిలింది"],
             "German": ["was muss ich heute tun", "was ist noch auf meiner liste"]},
            [{"action": "list", "flavor": f} for f in ("", "today", "now", "please", "so far")], 10),
        grp({"English": ["i need to {title}", "remind me about {title}"],
             "Hindi": ["मुझे {title} करना है"],
             "Telugu": ["నేను {title} చేయాలి"],
             "German": ["ich muss {title} erledigen"]},
            [{"action": "add", "title": t, "flavor": f} for t in TASKS for f in ("", "please")], 9),
        grp({"English": ["did i finish {title}", "is {title} done"],
             "Hindi": ["क्या मैंने {title} पूरा किया"],
             "Telugu": ["నేను {title} పూర్తి చేశానా"],
             "German": ["habe ich {title} erledigt"]},
            [{"action": "complete", "title": t, "flavor": f} for t in TASKS for f in ("", "please")], 8),
    ],
    "remember": [
        grp({"English": ["what do you remember about me", "what do you know about me"],
             "Hindi": ["मेरे बारे में तुम्हें क्या याद है"],
             "Telugu": ["నా గురించి నీకు ఏమి గుర్తుంది"],
             "German": ["was erinnerst du dich über mich"]},
            [{"action": "list", "flavor": f} for f in ("", "today", "so far", "now", "please")], 12),
        grp({"English": ["i'm allergic to peanuts", "my dog's name is Rex"],
             "Hindi": ["मुझे मूंगफली से एलर्जी है"],
             "Telugu": ["నాకు పల్లీలతో అలర్జీ ఉంది"],
             "German": ["ich bin allergisch gegen erdnüsse"]},
            [{"action": "save", "topic": t, "value": v, "flavor": f} for t, v in
             (("allergy", "peanuts"), ("dog's name", "Rex"), ("birthday", "12 May"), ("locker number", "42"), ("favourite colour", "blue")) for f in ("", "please")], 10),
        grp({"English": ["forget my {topic}", "forget my {topic} now"],
             "Hindi": ["मेरा {topic} भूल जाओ"],
             "Telugu": ["నా {topic} మర్చిపో"],
             "German": ["vergiss mein {topic}"]},
            [{"action": "forget", "topic": "favourite sweet", "flavor": f} for f in ("", "now", "please", "for me", "entirely")], 5),
    ],
    "app_control": [grp({
        "English": ["can you launch {name}", "bring {name} to the front", "shut {name} down"],
        "Hindi": ["{name} चालू कर सकते हो", "{name} सामने ला सकते हो"],
        "Telugu": ["{name} ప్రారంభించగలరా", "{name} ముందుకు తీసుకురాగలరా"],
        "German": ["kannst du {name} starten", "bringe {name} nach vorne"],
    }, [{"action": a, "name": n} for a in ("open", "close", "focus") for n in APPS], 27)],
    "volume_control": [grp({
        "English": ["make it louder", "turn it down", "silence the speaker", "what's the volume"],
        "Hindi": ["आवाज़ बढ़ाओ", "आवाज़ कम करो", "स्पीकर चुप करो"],
        "Telugu": ["శబ్దం పెంచండి", "శబ్దం తగ్గించండి", "స్పీకర్ ఆపండి"],
        "German": ["mach es lauter", "mach es leiser", "schalte den ton stumm"],
    }, [{"action": a, "level": lv, "flavor": f} for a, lv in (("set", 80), ("set", 30), ("mute", None), ("get", None)) for f in ("", "please", "now")], 27)],
    "device_status": [grp({
        "English": ["am i about to run out of charge", "what's eating my cpu", "is the battery low"],
        "Hindi": ["क्या बैटरी खत्म होने वाली है", "सीपीयू कौन खा रहा है"],
        "Telugu": ["బ్యాటరీ అయిపోతుందా", "సీపీయూ ఏమి వాడుతోంది"],
        "German": ["geht mir der akku aus", "was frisst meine cpu"],
    }, [{"what": w, "flavor": f} for w in ("battery", "processes") for f in ("", "please", "now")], 27)],
    "gmail_search": [grp({
        "English": ["did {name} write to me", "anything new in my mail", "any unread messages"],
        "Hindi": ["{name} ने लिखा क्या", "मेरे मेल में कुछ नया है क्या"],
        "Telugu": ["{name} రాశారా", "నా మెయిల్‌లో కొత్తది ఏమైనా ఉందా"],
        "German": ["hat {name} mir geschrieben", "gibt es neue nachrichten"],
    }, [{"query": f"from:{n.lower()}", "unread_only": True, "name": n, "flavor": f} for n in PEOPLE for f in ("", "please", "now")], 27)],
    "gmail_read": [grp({
        "English": ["did {name} reply", "what did {name} say", "read the message from {name}"],
        "Hindi": ["{name} ने जवाब दिया क्या", "{name} ने क्या कहा"],
        "Telugu": ["{name} సమాధానం ఇచ్చారా", "{name} ఏమి చెప్పారు"],
        "German": ["hat {name} geantwortet", "was hat {name} gesagt"],
    }, [{"query": f"from:{n.lower()}", "name": n, "flavor": f} for n in PEOPLE for f in ("", "please", "now")], 27)],
    "gmail_draft": [grp({
        "English": ["tell {to} the {subject} is ready by email", "write to {to} about the {subject}"],
        "Hindi": ["{to} को मेल में बताओ कि {subject} तैयार है"],
        "Telugu": ["{to} కి మెయిల్‌లో చెప్పండి {subject} సిద్ధంగా ఉంది"],
        "German": ["schreib {to}, dass {subject} fertig ist"],
    }, [{"to": n, "subject": s.title(), "body": f"Hi {n}, the {s} is ready.", "flavor": f} for n in PEOPLE for s in SUBJECTS for f in ("", "please")], 27)],
    "gmail_send": [grp({
        "English": ["go ahead and send it", "send that draft now", "yes send the draft"],
        "Hindi": ["हाँ भेज दो", "वह ड्राफ्ट भेज दो"],
        "Telugu": ["సరే పంపండి", "ఆ డ్రాఫ్ట్ పంపండి"],
        "German": ["ja sende den entwurf", "schick den entwurf jetzt"],
    }, [{"to": n, "subject": s.title(), "flavor": f} for n in PEOPLE for s in SUBJECTS for f in ("", "please")], 27)],
    "calendar_agenda": [grp({
        "English": ["am i free tomorrow", "what's my schedule", "do i have meetings tomorrow"],
        "Hindi": ["कल मैं खाली हूँ क्या", "मेरा शेड्यूल क्या है"],
        "Telugu": ["రేపు నేను ఖాళీగా ఉన్నానా", "నా షెడ్యూల్ ఏమిటి"],
        "German": ["habe ich morgen zeit", "wie ist mein zeitplan"],
    }, [{"date_offset": o, "days": d, "flavor": f} for o in (0, 1) for d in (1, 2, 7) for f in ("", "please")], 27)],
    "calendar_create": [grp({
        "English": ["book {title} {when} at {time}", "block time for {title} {when} at {time}"],
        "Hindi": ["{when} {time} पर {title} बुक करो"],
        "Telugu": ["{when} {time} కి {title} బుక్ చేయండి"],
        "German": ["buche {title} {when} um {time}"],
    }, [{"title": t, "date_offset": o, "time": tm, "when": w, "duration_minutes": d, "flavor": f}
        for t in ("Dentist", "Project kickoff", "Deep work", "Team sync", "Gym", "Doctor")
        for o, w in ((0, "today"), (1, "tomorrow")) for tm, d, f in (("10:00", 60, ""), ("18:00", 90, "please"))], 27)],
    "current_time": [grp({
        "English": ["what day is it today", "what's the date today"],
        "Hindi": ["आज कौन सा दिन है", "आज तारीख क्या है"],
        "Telugu": ["ఈరోజు ఏ రోజు", "ఈరోజు తేదీ ఏమిటి"],
        "German": ["welcher tag ist heute", "welches datum ist heute"],
    }, [{"what": w, "flavor": f} for w in ("time", "date") for f in ("", "please", "now", "today")], 27)],
    "music_control": [grp({
        "English": ["put on some {query}", "can you play {query}", "turn off the music"],
        "Hindi": ["{query} का कुछ चलाओ", "{query} बजाओ", "संगीत बंद करो"],
        "Telugu": ["{query} పాట వేయండి", "{query} ప్లే చేయండి", "సంగీతం ఆపండి"],
        "German": ["spiele etwas von {query}", "kannst du {query} spielen", "schalte die musik aus"],
    }, [{"action": "play", "query": s, "flavor": f} for s in SONGS for f in ("", "please")] + [{"action": "stop", "flavor": f} for f in ("", "please", "now")], 27)],
    "get_room_temperature": [grp({
        "English": ["is it too hot in here", "should i open a window", "is it humid inside"],
        "Hindi": ["यहाँ बहुत गर्मी है क्या", "खिड़की खोलनी चाहिए क्या"],
        "Telugu": ["ఇక్కడ చాలా వేడిగా ఉందా", "కిటికీ తెరవాలా"],
        "German": ["ist es hier zu heiß", "soll ich ein fenster öffnen"],
    }, [{"flavor": f} for f in ("", "please", "now", "today", "right now")], 27, advise=True)],
}

FP_TOPIC = {
    "get_weather": "weather", "get_weather_forecast": "forecast", "convert_currency": "currency",
    "web_search": "web search", "tasks": "to-do list", "remember": "memory", "app_control": "apps",
    "volume_control": "volume", "device_status": "battery", "gmail_search": "email search",
    "gmail_read": "inbox email", "gmail_draft": "draft email", "gmail_send": "outgoing email", "calendar_agenda": "calendar",
    "calendar_create": "calendar events", "current_time": "time", "music_control": "music",
    "get_room_temperature": "room temperature",
}

FP_PATTERNS = {
    "English": ["i hate being asked about {topic}", "my {topic} app is broken", "the word {topic} is weird",
                "{topic} is boring", "i was reading about {topic} yesterday", "i don't want any {topic} updates today",
                "we talked about {topic} yesterday"],
    "Hindi": ["मुझे {topic} के बारे में पूछना पसंद नहीं", "मेरा {topic} ऐप खराब है", "{topic} शब्द अजीब है",
              "{topic} उबाऊ है", "मैं कल {topic} के बारे में पढ़ रहा था", "मुझे आज {topic} अपडेट नहीं चाहिए",
              "हम कल {topic} के बारे में बात कर रहे थे"],
    "Telugu": ["{topic} గురించి అడగడం నాకు ఇష్టం లేదు", "నా {topic} యాప్ పనిచేయడం లేదు", "{topic} అనే పదం వింతగా ఉంది",
               "{topic} బోరింగ్", "నిన్న నేను {topic} గురించి చదివాను", "ఈరోజు నాకు {topic} అప్‌డేట్లు వద్దు",
               "నిన్న మేము {topic} గురించి మాట్లాడాము"],
    "German": ["ich hasse es, nach {topic} gefragt zu werden", "meine {topic}-app ist kaputt", "das wort {topic} ist seltsam",
               "{topic} ist langweilig", "ich habe gestern über {topic} gelesen", "ich will heute keine {topic}-updates",
               "wir haben gestern über {topic} gesprochen"],
}

CHAT = {
    "English": ["who wrote the ramayana", "explain recursion in simple words", "what should i name my new cat",
                "good morning", "thanks that was helpful", "tell me a joke", "what are we discussing",
                "what is the capital of japan", "how far is the moon", "i feel tired today",
                "i love jazz music", "what is 2+2", "what is a jwt token", "how do vaccines work",
                "write a short poem about rain", "i had a rough day", "what is your favourite colour",
                "how do i learn guitar", "what is the meaning of life", "good night veda"],
    "Hindi": ["रामायण किसने लिखी", "रिकर्सन समझाओ", "मेरी नई बिल्ली का नाम क्या रखूँ", "सुप्रभात", "धन्यवाद",
              "एक चुटकुला सुनाओ", "हम किस बारे में बात कर रहे हैं", "जापान की राजधानी क्या है", "चाँद कितनी दूर है",
              "आज मैं थका हुआ हूँ", "मुझे जैज़ संगीत पसंद है", "2+2 कितना है", "जेडब्ल्यूटी टोकन क्या है",
              "टीके कैसे काम करते हैं", "बारिश पर छोटी कविता लिखो", "आज मेरा दिन कठिन था", "तुम्हारा पसंदीदा रंग क्या है",
              "गिटार सीखना कैसे शुरू करूँ", "जीवन का अर्थ क्या है", "शुभ रात्रि वेदा"],
    "Telugu": ["రామాయణం ఎవరు రాశారు", "రికర్షన్ వివరించండి", "నా కొత్త పిల్లి పేరు ఏమి పెట్టాలి", "శుభోదయం", "ధన్యవాదాలు",
               "ఒక జోక్ చెప్పండి", "మనం ఏమి మాట్లాడుతున్నాము", "జపాన్ రాజధాని ఏమిటి", "చంద్రుడు ఎంత దూరం", "ఈరోజు అలసటగా ఉంది",
               "నాకు జాజ్ సంగీతం ఇష్టం", "2+2 ఎంత", "జెడబ్ల్యూటీ టోకెన్ అంటే ఏమిటి", "టీకాలు ఎలా పనిచేస్తాయి",
               "వర్షం గురించి చిన్న కవిత రాయండి", "ఈరోజు కష్టంగా గడిచింది", "నీకు ఇష్టమైన రంగు ఏమిటి", "గిటార్ ఎలా నేర్చుకోవాలి",
               "జీవితం అర్థం ఏమిటి", "శుభరాత్రి వేదా"],
    "German": ["wer hat das ramayana geschrieben", "erkläre rekursion einfach", "wie soll ich meine neue katze nennen",
               "guten morgen", "danke das war hilfreich", "erzähl mir einen witz", "worüber sprechen wir",
               "was ist die hauptstadt von japan", "wie weit ist der mond", "ich fühle mich heute müde",
               "ich liebe jazzmusik", "was ist 2+2", "was ist ein jwt-token", "wie funktionieren impfstoffe",
               "schreib ein kurzes gedicht über regen", "ich hatte einen harten tag", "was ist deine lieblingsfarbe",
               "wie lerne ich gitarre", "was ist der sinn des lebens", "gute nacht veda"],
}

CLARIFY = {
    "English": ["and in delhi", "what about tomorrow", "the second one", "delete it", "get rid of that one",
                "email priya", "put it on my calendar", "what time should i set it for", "which one",
                "and there", "what about the other one", "send it", "add it to my list", "remind me about it",
                "read it", "what about next week", "and for me", "the first one", "do that", "what does it say"],
    "Hindi": ["और दिल्ली में", "कल के बारे में क्या", "दूसरा वाला", "इसे डिलीट करो", "उस वाले से छुटकारा दो",
              "प्रिया को मेल भेजो", "इसे मेरे कैलेंडर में डालो", "कितने बजे सेट करूँ", "कौन सा",
              "वहाँ के बारे में", "दूसरे के बारे में क्या", "भेज दो", "इसे लिस्ट में जोड़ो", "इसके बारे में याद दिलाओ",
              "इसे पढ़ो", "अगले हफ्ते के बारे में क्या", "मेरे लिए", "पहला वाला", "वह करो", "इसमें क्या लिखा है"],
    "Telugu": ["ఇంకా ఢిల్లీలో", "రేపు గురించి ఏమిటి", "రెండోది", "దాన్ని తొలగించండి", "అది వదిలించుకోండి",
               "ప్రియాకు మెయిల్ పంపండి", "దాన్ని నా క్యాలెండర్‌లో పెట్టండి", "ఎన్ని గంటలకు సెట్ చేయాలి", "ఏది",
               "అక్కడ గురించి", "మరొకటి గురించి ఏమిటి", "పంపండి", "దాన్ని లిస్ట్‌లో జోడించండి", "దాని గురించి గుర్తు చేయండి",
               "దాన్ని చదవండి", "వచ్చే వారం గురించి ఏమిటి", "నా కోసం", "మొదటిది", "అది చేయండి", "అందులో ఏమి ఉంది"],
    "German": ["und in delhi", "was ist mit morgen", "das zweite", "lösche es", "werde das los",
               "schreib priya eine mail", "trag es in meinen kalender ein", "für wie viel uhr", "welches",
               "und dort", "was ist mit dem anderen", "sende es", "füge es meiner liste hinzu", "erinnere mich daran",
               "lies es", "was ist mit nächster woche", "und für mich", "das erste", "mach das", "was steht darin"],
}

REFUSE = {
    "English": ["how bad is the traffic to the airport", "what's the flight status of indigo 6e 204",
                "what time is it in tokyo", "cancel my 5 pm meeting", "move my dentist appointment to friday",
                "what's the score of the match right now", "how much is gold per gram today",
                "is the stock market open now", "what's the weather in space", "how many people are online right now"],
    "Hindi": ["एयरपोर्ट का ट्रैफिक कैसा है", "इंडिगो 6ई 204 की फ्लाइट स्टेटस क्या है", "टोक्यो में क्या समय है",
              "मेरी 5 बजे की मीटिंग कैंसिल करो", "मेरा डेंटिस्ट अपॉइंटमेंट शुक्रवार को करो",
              "अभी मैच का स्कोर क्या है", "सोने का भाव आज कितना है", "क्या शेयर बाजार अभी खुला है",
              "अंतरिक्ष में मौसम कैसा है", "अभी कितने लोग ऑनलाइन हैं"],
    "Telugu": ["ఎయిర్‌పోర్ట్ ట్రాఫిక్ ఎలా ఉంది", "ఇండిగో 6ఈ 204 ఫ్లైట్ స్టేటస్ ఏమిటి", "టోక్యోలో సమయం ఎంత",
               "నా 5 గంటల మీటింగ్ రద్దు చేయండి", "నా డెంటిస్ట్ అపాయింట్‌మెంట్ శుక్రవారానికి మార్చండి",
               "ఇప్పుడు మ్యాచ్ స్కోర్ ఎంత", "ఈరోజు బంగారం ధర ఎంత", "స్టాక్ మార్కెట్ ఇప్పుడు తెరిచి ఉందా",
               "అంతరిక్షంలో వాతావరణం ఎలా ఉంది", "ఇప్పుడు ఎంత మంది ఆన్‌లైన్ ఉన్నారు"],
    "German": ["wie schlimm ist der verkehr zum flughafen", "was ist der flugstatus von indigo 6e 204",
               "wie spät ist es in tokio", "sage mein meeting um 5 uhr ab", "verschiebe meinen zahnarzttermin auf freitag",
               "wie ist der spielstand gerade", "wie viel kostet gold heute pro gramm", "ist die börse jetzt geöffnet",
               "wie ist das wetter im weltraum", "wie viele leute sind gerade online"],
}

samples: list[Sample] = []
seen: set[str] = set()


EXTRA = [
    " please", " now", " today", " for me", " right now", " asap", " quickly",
    " if possible", " when you can", " when you get a chance", " thanks", " please do",
    " at once", " immediately", " soon", " this time", " again", " exactly",
    " for today", " for now", " at the moment", " currently", " so far", " please now",
    " right away", " whenever", " if you can", " kindly", " today please", " now please",
]


def add(category: str, tool: str | None, user: str, label: dict, *, active: str = "", prefix: str = "") -> None:
    user = (prefix + user).strip()
    key = user.lower()
    if key in seen:
        for extra in EXTRA:
            cand = with_suffix(user, extra)
            if cand.lower() not in seen:
                user, key = cand, cand.lower()
                break
        else:
            n = 2
            while f"{user} ({n})".lower() in seen:
                n += 1
            user = f"{user} ({n})"
            key = user.lower()
    seen.add(key)
    idx = len(samples) + 1
    samples.append(Sample(
        id=f"ctl-{idx:04d}", category=category, user=user, label=label, active=active,
        today="2026-11-01T19:00", tools=None, source="synthetic", group=f"ctl-{idx:04d}",
        status="final", notes=f"tool={tool or 'none'} lang={label.get('language')}",
    ))


def clean_args(value: dict) -> dict:
    return {k: v for k, v in value.items() if k not in ("flavor", "when", "scope", "where") and v is not None}


def gen_tool_groups(tool: str, groups: list[dict], category: str) -> None:
    for group in groups:
        patterns, values, count = group["patterns"], group["values"], group["count"]
        for j in range(count):
            lang = LANGS[j % 4]
            k = j // 4
            pats = patterns[lang]
            pat = pats[k % len(pats)]
            value = values[k % len(values)]
            suffix = SUFFIX[lang][(k // len(pats)) % len(SUFFIX[lang])]
            text = with_suffix(pat.format(**value), suffix)
            args = {} if tool == "gmail_send" else clean_args(value)
            if tool in ("gmail_search", "gmail_read"):
                args.pop("name", None)
            if tool == "gmail_search":
                args.pop("subject", None)
            active = ""
            if tool == "gmail_send":
                active = f"ACTIVE: gmail_draft | to={value.get('to')} subject={value.get('subject')} | just now"
            label = {"needs_live_data": True, "calls": [{"tool": tool, "args": args}], "language": lang}
            if group.get("advise") or any(w.lower() in text.lower() for w in ADVISE_WORDS):
                label["advise"] = True
            add(category, tool, text, label, active=active)


for tool, groups in TP.items():
    gen_tool_groups(tool, groups, "TP")

for i in range(50):
    lang = LANGS[i % 4]
    text = CHAT[lang][(i // 4) % len(CHAT[lang])]
    add("TP", None, text, {"needs_live_data": False, "calls": [], "language": lang})

for i in range(50):
    lang = LANGS[i % 4]
    text = CLARIFY[lang][(i // 4) % len(CLARIFY[lang])]
    add("TP", None, text, {"needs_live_data": False, "calls": [], "language": lang,
                           "clarification": "What do you mean?"})

for idx, (tool, topic) in enumerate(FP_TOPIC.items()):
    target = 28 if idx < 14 else 27
    for j in range(target):
        lang = LANGS[j % 4]
        k = j // 4
        pats = FP_PATTERNS[lang]
        pat = pats[k % len(pats)]
        suffix = SUFFIX[lang][(k // len(pats)) % len(SUFFIX[lang])]
        text = with_suffix(pat.format(topic=topic), suffix)
        add("FP", tool, text, {"needs_live_data": False, "calls": [], "language": lang})

for idx, (tool, groups) in enumerate(FN.items()):
    target = 28 if idx < 14 else 27
    total = sum(g["count"] for g in groups)
    scaled = [{**g, "count": max(1, round(g["count"] * target / total))} for g in groups]
    diff = target - sum(g["count"] for g in scaled)
    scaled[0]["count"] += diff
    gen_tool_groups(tool, scaled, "FN")

for i in range(300):
    lang = LANGS[i % 4]
    text = CHAT[lang][(i // 4) % len(CHAT[lang])] + SUFFIX[lang][(i // 4 // len(CHAT[lang])) % len(SUFFIX[lang])]
    add("TN", None, text, {"needs_live_data": False, "calls": [], "language": lang}, prefix="so ")

for i in range(100):
    lang = LANGS[i % 4]
    text = CLARIFY[lang][(i // 4) % len(CLARIFY[lang])] + SUFFIX[lang][(i // 4 // len(CLARIFY[lang])) % len(SUFFIX[lang])]
    add("TN", None, text, {"needs_live_data": False, "calls": [], "language": lang,
                           "clarification": "What do you mean?"}, prefix="also ")

for i in range(100):
    lang = LANGS[i % 4]
    text = REFUSE[lang][(i // 4) % len(REFUSE[lang])] + SUFFIX[lang][(i // 4 // len(REFUSE[lang])) % len(SUFFIX[lang])]
    add("TN", None, text, {"needs_live_data": True, "calls": [], "language": lang}, prefix="hey ")

out = ROOT / "training" / "datasets" / "control_20skills_2500.jsonl"
dump(samples, out)
print("wrote", len(samples), "->", out)
print("categories:", dict(Counter(s.category for s in samples)))
print("languages:", dict(Counter(s.label.get("language") for s in samples)))

errors = 0
for s in samples:
    issues = validate(s)
    hard = [i for i in issues if i.level == "error"]
    if hard:
        errors += 1
        if errors <= 10:
            print("ERR", s.id, s.user[:60], hard[:2])
print("validation errors:", errors, "/", len(samples))
