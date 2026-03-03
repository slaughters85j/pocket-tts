"""
Lightweight text normalization for TTS preprocessing.

Converts raw text into a form that SentencePiece + the TTS model
can pronounce correctly. Pure regex + num2words, no heavy NLP libs.

Runs in microseconds on typical input lengths.
"""

import re

from num2words import num2words

# --- Unit expansion ---

# Values are (singular, plural) tuples to handle irregular plurals correctly.
_UNITS: dict[str, tuple[str, str]] = {
    # Length
    "mm": ("millimeter", "millimeters"),
    "cm": ("centimeter", "centimeters"),
    "m": ("meter", "meters"),
    "km": ("kilometer", "kilometers"),
    "in": ("inch", "inches"),
    "ft": ("foot", "feet"),
    "yd": ("yard", "yards"),
    "mi": ("mile", "miles"),
    "nm": ("nanometer", "nanometers"),
    "um": ("micrometer", "micrometers"),
    # Mass
    "mg": ("milligram", "milligrams"),
    "g": ("gram", "grams"),
    "kg": ("kilogram", "kilograms"),
    "lb": ("pound", "pounds"),
    "lbs": ("pound", "pounds"),
    "oz": ("ounce", "ounces"),
    # Volume
    "ml": ("milliliter", "milliliters"),
    "l": ("liter", "liters"),
    "gal": ("gallon", "gallons"),
    "qt": ("quart", "quarts"),
    "pt": ("pint", "pints"),
    # Speed
    "mph": ("mile per hour", "miles per hour"),
    "kph": ("kilometer per hour", "kilometers per hour"),
    "fps": ("foot per second", "feet per second"),
    "mps": ("meter per second", "meters per second"),
    # Temperature
    "°C": ("degree Celsius", "degrees Celsius"),
    "°F": ("degree Fahrenheit", "degrees Fahrenheit"),
    # Data — lowercase b = bits (convention: b=bit, B=byte)
    # Byte forms are selected at runtime when the raw input has uppercase B.
    "kb": ("kilobit", "kilobits"),
    "mb": ("megabit", "megabits"),
    "gb": ("gigabit", "gigabits"),
    "tb": ("terabit", "terabits"),
    "kbps": ("kilobit per second", "kilobits per second"),
    "mbps": ("megabit per second", "megabits per second"),
    "gbps": ("gigabit per second", "gigabits per second"),
    # Time
    "ms": ("millisecond", "milliseconds"),
    "ns": ("nanosecond", "nanoseconds"),
    "hz": ("hertz", "hertz"),
    "khz": ("kilohertz", "kilohertz"),
    "mhz": ("megahertz", "megahertz"),
    "ghz": ("gigahertz", "gigahertz"),
    # Power / Electrical
    "w": ("watt", "watts"),
    "kw": ("kilowatt", "kilowatts"),
    "mw": ("megawatt", "megawatts"),
    "v": ("volt", "volts"),
    "kv": ("kilovolt", "kilovolts"),
    "ma": ("milliamp", "milliamps"),
    "db": ("decibel", "decibels"),
    # Misc
    "rpm": ("revolution per minute", "revolutions per minute"),
    "psi": ("pound per square inch", "pounds per square inch"),
    "sqft": ("square foot", "square feet"),
    "sqm": ("square meter", "square meters"),
    # ISR / Remote Sensing / Radar / Physics
    "dbm": ("decibel-milliwatt", "decibel-milliwatts"),
    "dbi": ("decibel isotropic", "decibel isotropic"),
    "dbw": ("decibel-watt", "decibel-watts"),
    "dbsm": ("decibel square meter", "decibel square meters"),
    "dbc": ("decibel relative to carrier", "decibel relative to carrier"),
    "dbd": ("decibel relative to dipole", "decibel relative to dipole"),
    "dbr": ("decibel relative", "decibel relative"),
    "dbhz": ("decibel-hertz", "decibel-hertz"),
    "dbuv": ("decibel-microvolt", "decibel-microvolts"),
    "sr": ("steradian", "steradians"),
    "mrad": ("milliradian", "milliradians"),
    "urad": ("microradian", "microradians"),
    "nmi": ("nautical mile", "nautical miles"),
    "kn": ("knot", "knots"),
    "kt": ("knot", "knots"),
    # Distance (extended)
    "pm": ("picometer", "picometers"),
    "au": ("astronomical unit", "astronomical units"),
    "ly": ("light-year", "light-years"),
    "pc": ("parsec", "parsecs"),
    # Area
    "m²": ("square meter", "square meters"),
    "km²": ("square kilometer", "square kilometers"),
    "ft²": ("square foot", "square feet"),
    "mi²": ("square mile", "square miles"),
    # Volume (extended)
    "m³": ("cubic meter", "cubic meters"),
    "km³": ("cubic kilometer", "cubic kilometers"),
    "ft³": ("cubic foot", "cubic feet"),
    "cl": ("centiliter", "centiliters"),
    "dl": ("deciliter", "deciliters"),
    "hl": ("hectoliter", "hectoliters"),
    # Power (extended)
    "gw": ("gigawatt", "gigawatts"),
    "hp": ("horsepower", "horsepower"),
    # Mass (extended)
    "ug": ("microgram", "micrograms"),
    "st": ("stone", "stone"),
    # Time (extended)
    "ps": ("picosecond", "picoseconds"),
    "us": ("microsecond", "microseconds"),
    # Angle
    "deg": ("degree", "degrees"),
    "rad": ("radian", "radians"),
    # Pressure
    "pa": ("pascal", "pascals"),
    "hpa": ("hectopascal", "hectopascals"),
    "kpa": ("kilopascal", "kilopascals"),
    "mpa": ("megapascal", "megapascals"),
    "bar": ("bar", "bar"),
    "mbar": ("millibar", "millibar"),
    "atm": ("atmosphere", "atmospheres"),
    "torr": ("torr", "torr"),
    "mmhg": ("millimeter of mercury", "millimeters of mercury"),
    "inhg": ("inch of mercury", "inches of mercury"),
    # Concentration
    "ppm": ("part per million", "parts per million"),
    "ppb": ("part per billion", "parts per billion"),
    "ppt": ("part per trillion", "parts per trillion"),
    "ppq": ("part per quadrillion", "parts per quadrillion"),
}

# Build regex: match number (with optional decimal) followed by unit
# Sort units longest-first so "kbps" matches before "kb"
_UNIT_KEYS_SORTED = sorted(_UNITS.keys(), key=len, reverse=True)
_UNIT_PATTERN = re.compile(
    r"(\d+(?:\.\d+)?)\s*(" + "|".join(re.escape(u) for u in _UNIT_KEYS_SORTED) + r")\b",
    re.IGNORECASE,
)


# Uppercase B = bytes. When the raw input has uppercase B, override bits → bytes.
_DATA_BYTE_FORMS: dict[str, tuple[str, str]] = {
    "kb": ("kilobyte", "kilobytes"),
    "mb": ("megabyte", "megabytes"),
    "gb": ("gigabyte", "gigabytes"),
    "tb": ("terabyte", "terabytes"),
}


def _expand_number_with_unit(match: re.Match) -> str:
    number_str = match.group(1)
    unit_raw = match.group(2)
    unit_key = unit_raw.lower()

    # Special case: preserve "°C" and "°F" casing
    if unit_raw in ("°C", "°F"):
        unit_key = unit_raw

    forms = _UNITS.get(unit_key)

    # Data units: uppercase B in the raw input means bytes, not bits.
    # e.g. "KB" / "kB" → kilobytes, but "kb" → kilobits
    if unit_key in _DATA_BYTE_FORMS and unit_raw.endswith("B"):
        forms = _DATA_BYTE_FORMS[unit_key]

    if forms is None:
        expansion = unit_raw
    else:
        # Pick singular or plural from the explicit (singular, plural) tuple
        try:
            val = float(number_str)
            expansion = forms[0] if val == 1.0 else forms[1]
        except ValueError:
            expansion = forms[1]

    number_words = _number_to_words(number_str)
    return f"{number_words} {expansion}"


# --- Standalone unit expansion ---
# Handles units that appear WITHOUT a preceding number (e.g. "per kg", "in mm").
# Only includes multi-character units that are unambiguous as standalone words.
# Single-char units (m, v, w, g, l) are excluded — too many false positives.
_STANDALONE_UNITS: dict[str, str] = {
    "kg": "kilograms",
    "km": "kilometers",
    "mm": "millimeters",
    "cm": "centimeters",
    "nm": "nanometers",
    "um": "micrometers",
    "mg": "milligrams",
    "lb": "pounds",
    "lbs": "pounds",
    "oz": "ounces",
    "ml": "milliliters",
    "gal": "gallons",
    "mph": "miles per hour",
    "kph": "kilometers per hour",
    "fps": "feet per second",
    "mps": "meters per second",
    "kb": "kilobits",
    "mb": "megabits",
    "gb": "gigabits",
    "tb": "terabits",
    "kbps": "kilobits per second",
    "mbps": "megabits per second",
    "gbps": "gigabits per second",
    "ms": "milliseconds",
    "ns": "nanoseconds",
    "hz": "hertz",
    "khz": "kilohertz",
    "mhz": "megahertz",
    "ghz": "gigahertz",
    "kw": "kilowatts",
    "mw": "megawatts",
    "kv": "kilovolts",
    "gw": "gigawatts",
    "ma": "milliamps",
    "db": "decibels",
    "rpm": "revolutions per minute",
    "psi": "pounds per square inch",
    "sqft": "square feet",
    "sqm": "square meters",
    # Decibel variants
    "dbm": "decibel-milliwatts",
    "dbi": "decibel isotropic",
    "dbw": "decibel-watts",
    "dbsm": "decibel square meters",
    "dbc": "decibel relative to carrier",
    "dbd": "decibel relative to dipole",
    "dbr": "decibel relative",
    "dbhz": "decibel-hertz",
    "dbuv": "decibel-microvolts",
    # Pressure
    "hpa": "hectopascals",
    "kpa": "kilopascals",
    "mpa": "megapascals",
    "mbar": "millibar",
    "atm": "atmospheres",
    "torr": "torr",
    "mmhg": "millimeters of mercury",
    "inhg": "inches of mercury",
    # Concentration
    "ppm": "parts per million",
    "ppb": "parts per billion",
    "ppt": "parts per trillion",
    "ppq": "parts per quadrillion",
    # Distance (extended)
    "nmi": "nautical miles",
    "mrad": "milliradians",
}

_STANDALONE_KEYS_SORTED = sorted(_STANDALONE_UNITS.keys(), key=len, reverse=True)
_STANDALONE_UNIT_PATTERN = re.compile(
    r"(?<!\d)(?<!\w)(" + "|".join(re.escape(u) for u in _STANDALONE_KEYS_SORTED) + r")\b",
    re.IGNORECASE,
)


def _expand_standalone_unit(match: re.Match) -> str:
    raw = match.group(1)
    key = raw.lower()
    # Respect uppercase B = bytes for standalone data units too
    if key in _DATA_BYTE_FORMS and raw.endswith("B"):
        return _DATA_BYTE_FORMS[key][1]  # plural form
    return _STANDALONE_UNITS.get(key, raw)


# --- Abbreviation expansion ---

_ABBREVIATIONS = {
    "Dr.": "Doctor",
    "Mr.": "Mister",
    "Mrs.": "Missus",
    "Ms.": "Miss",
    "Jr.": "Junior",
    "Sr.": "Senior",
    "Prof.": "Professor",
    "Gen.": "General",
    "Gov.": "Governor",
    "Sgt.": "Sergeant",
    "Cpl.": "Corporal",
    "LCpl.": "Lance Corporal",
    "Lt.": "Lieutenant",
    "Col.": "Colonel",
    "Capt.": "Captain",
    "Cmdr.": "Commander",
    "Adm.": "Admiral",
    "Rev.": "Reverend",
    "St.": "Saint",
    "Ave.": "Avenue",
    "Blvd.": "Boulevard",
    "Dept.": "Department",
    "Govt.": "Government",
    "Inc.": "Incorporated",
    "Corp.": "Corporation",
    "Ltd.": "Limited",
    "Co.": "Company",
    "vs.": "versus",
    "etc.": "etcetera",
    "approx.": "approximately",
    "est.": "estimated",
    "min.": "minimum",
    "max.": "maximum",
    "avg.": "average",
    "no.": "number",
    "Jan.": "January",
    "Feb.": "February",
    "Mar.": "March",
    "Apr.": "April",
    "Jun.": "June",
    "Jul.": "July",
    "Aug.": "August",
    "Sep.": "September",
    "Sept.": "September",
    "Oct.": "October",
    "Nov.": "November",
    "Dec.": "December",
}

# Build case-insensitive abbreviation pattern
_ABBREV_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(a) for a in _ABBREVIATIONS.keys()) + r")", re.IGNORECASE
)


def _expand_abbreviation(match: re.Match) -> str:
    raw = match.group(0)
    # Try exact match first, then title-cased, then lowercase.
    # The regex uses re.IGNORECASE so input could be "VS.", "vs.", "Vs.", etc.
    if raw in _ABBREVIATIONS:
        return _ABBREVIATIONS[raw]
    titled = raw[0].upper() + raw[1:].lower()
    if titled in _ABBREVIATIONS:
        return _ABBREVIATIONS[titled]
    lowered = raw.lower()
    if lowered in _ABBREVIATIONS:
        return _ABBREVIATIONS[lowered]
    return raw


# --- Number conversion ---

# Ordinals: 1st, 2nd, 3rd, 4th, etc.
_ORDINAL_PATTERN = re.compile(r"\b(\d+)(st|nd|rd|th)\b", re.IGNORECASE)

# Currency: $100, $3.50, €50, £20
_CURRENCY_PATTERN = re.compile(r"([$€£])(\d+(?:\.\d{1,2})?)")

_CURRENCY_NAMES = {"$": ("dollar", "dollars"), "€": ("euro", "euros"), "£": ("pound", "pounds")}

# Currency with magnitude words: $3.5 billion, €12 million, £200 thousand
_CURRENCY_MAGNITUDE_PATTERN = re.compile(
    r"([$€£])(\d+(?:\.\d+)?)\s*(billion|million|trillion|thousand)\b", re.IGNORECASE
)


def _expand_currency_magnitude(match: re.Match) -> str:
    symbol = match.group(1)
    number_str = match.group(2)
    magnitude = match.group(3).lower()
    _, plural = _CURRENCY_NAMES.get(symbol, ("unit", "units"))
    number_words = _number_to_words(number_str)
    return f"{number_words} {magnitude} {plural}"


# Percentage: 50%, 3.5%
_PERCENT_PATTERN = re.compile(r"(\d+(?:\.\d+)?)%")

# Time: 3:30, 14:05
_TIME_PATTERN = re.compile(r"\b(\d{1,2}):(\d{2})\b")

# Standalone numbers (integers and decimals) - matched AFTER units/currency/etc.
_NUMBER_PATTERN = re.compile(r"(?<!\w)(-?\d+(?:\.\d+)?)(?!\w|%|:)")

# Fractions: 1/2, 3/4 (but not dates like 01/15/2026)
_FRACTION_PATTERN = re.compile(r"\b(\d{1,3})/(\d{1,3})\b")

_FRACTION_NAMES = {
    (1, 2): "one half",
    (1, 3): "one third",
    (2, 3): "two thirds",
    (1, 4): "one quarter",
    (3, 4): "three quarters",
    (1, 5): "one fifth",
    (1, 8): "one eighth",
    (3, 8): "three eighths",
    (5, 8): "five eighths",
    (7, 8): "seven eighths",
}


def _number_to_words(s: str) -> str:
    """Convert a number string to words."""
    try:
        if "." in s:
            return num2words(float(s))
        else:
            return num2words(int(s))
    except (ValueError, OverflowError):
        return s


def _expand_ordinal(match: re.Match) -> str:
    num = int(match.group(1))
    try:
        return num2words(num, to="ordinal")
    except (ValueError, OverflowError):
        return match.group(0)


def _expand_currency(match: re.Match) -> str:
    symbol = match.group(1)
    amount_str = match.group(2)
    singular, plural = _CURRENCY_NAMES.get(symbol, ("unit", "units"))

    try:
        amount = float(amount_str)
    except ValueError:
        return match.group(0)

    if "." in amount_str:
        dollars = int(amount)
        cents = int(round((amount - dollars) * 100))
        parts = []
        if dollars:
            name = singular if dollars == 1 else plural
            parts.append(f"{num2words(dollars)} {name}")
        if cents:
            parts.append(f"{num2words(cents)} cents")
        return " and ".join(parts) if parts else match.group(0)
    else:
        name = singular if amount == 1 else plural
        return f"{num2words(int(amount))} {name}"


def _expand_percent(match: re.Match) -> str:
    return f"{_number_to_words(match.group(1))} percent"


def _expand_time(match: re.Match) -> str:
    hours = int(match.group(1))
    minutes = int(match.group(2))
    if minutes == 0:
        return f"{num2words(hours)} o'clock"
    elif minutes < 10:
        return f"{num2words(hours)} oh {num2words(minutes)}"
    else:
        return f"{num2words(hours)} {num2words(minutes)}"


def _expand_fraction(match: re.Match) -> str:
    num = int(match.group(1))
    den = int(match.group(2))
    if (num, den) in _FRACTION_NAMES:
        return _FRACTION_NAMES[(num, den)]
    try:
        num_words = num2words(num)
        den_words = num2words(den, to="ordinal")
        if num > 1:
            den_words += "s"
        return f"{num_words} {den_words}"
    except (ValueError, OverflowError):
        return match.group(0)


def _expand_standalone_number(match: re.Match) -> str:
    return _number_to_words(match.group(1))


# --- Acronym / initialism handling ---

# All-caps words 2-5 chars: NASA, FBI, CPU, GPU, etc.
_ACRONYM_PATTERN = re.compile(r"\b([A-Z]{2,5})\b")

_SPOKEN_ACRONYMS = {
    # Pronounceable - leave as-is (model handles these)
    "NASA",
    "NATO",
    "ASAP",
    "LASER",
    "RADAR",
    "SCUBA",
    # ISR / Remote Sensing / Defense
    "LIDAR",
    "SONAR",
    "FLIR",
    "NADIR",
    # Common words that happen to be all-caps
    "OK",
}


def _expand_acronym(match: re.Match) -> str:
    word = match.group(1)
    if word in _SPOKEN_ACRONYMS:
        return word
    # Spell it out with dots: FBI -> F.B.I.
    return ".".join(word) + "."


# --- Domain-specific terms ---
# Acronyms and abbreviations common in ISR, radar, EOIR, remote sensing,
# systems engineering (DoDAF, SysML, UML), and project management.
# These get explicit spoken forms rather than generic letter-by-letter spelling.
_ISR_TERMS: dict[str, str] = {
    # Intelligence disciplines
    "ISR": "I.S.R.",
    "SIGINT": "sig-int",
    "ELINT": "ee-lint",
    "COMINT": "com-int",
    "MASINT": "may-zint",
    "GEOINT": "gee-oh-int",
    "HUMINT": "hue-mint",
    "OSINT": "oh-sint",
    "IMINT": "im-int",
    "TECHINT": "tech-int",
    # Sensor / imaging
    "EOIR": "electro-optical infrared",
    "EO": "electro-optical",
    "IR": "infrared",
    "SAR": "synthetic aperture radar",
    "ISAR": "inverse synthetic aperture radar",
    "MTI": "moving target indicator",
    "GMTI": "ground moving target indicator",
    "AMTI": "airborne moving target indicator",
    "MWIR": "mid-wave infrared",
    "LWIR": "long-wave infrared",
    "SWIR": "short-wave infrared",
    "VNIR": "visible near infrared",
    "NIR": "near infrared",
    "TIR": "thermal infrared",
    "HSI": "hyperspectral imaging",
    "MSI": "multispectral imaging",
    "PAN": "panchromatic",
    "FWHM": "full-width at half-maximum",
    # Radar
    "PRF": "pulse repetition frequency",
    "PRI": "pulse repetition interval",
    "RCS": "radar cross section",
    "SNR": "signal to noise ratio",
    "CNR": "contrast to noise ratio",
    "EIRP": "effective isotropic radiated power",
    "RF": "radio frequency",
    "IF": "intermediate frequency",
    "LO": "local oscillator",
    "FFT": "fast Fourier transform",
    "AGC": "automatic gain control",
    "ADC": "analog to digital converter",
    "DAC": "digital to analog converter",
    "HPA": "high power amplifier",
    "LPA": "low power amplifier",
    # Image quality / performance
    "NIIRS": "national imagery interpretability rating scale",
    "GIQE": "general image quality equation",
    "GSD": "ground sample distance",
    "IFOV": "instantaneous field of view",
    "FOV": "field of view",
    "GRD": "ground resolved distance",
    "SRD": "system requirements document",
    "RMS": "root mean square",
    "TIN": "triangulated irregular network",
    # Thermal / radiometry
    "NETD": "N.E.T.D.",
    "NEDT": "N.E.D.T.",
    "NED": "N.E.D.",
    # Geospatial
    "GIS": "G.I.S.",
    "DEM": "dem",
    "DSM": "D.S.M.",
    "DTM": "D.T.M.",
    "DTED": "D.T.E.D.",
    "UTM": "U.T.M.",
    "MGRS": "M.G.R.S.",
    "WGS": "W.G.S.",
    # Systems / comms
    "CONOP": "con-op",
    "BER": "B.E.R.",
    "BW": "bandwidth",
    "SATCOM": "sat-com",
    "MILSPEC": "mil-spec",
    "COTS": "cots",
    "SWaP": "swap",
    "SWAP": "swap",
    # RF / microwave spectral bands (IEEE designation)
    "HF": "H.F.",
    "VHF": "V.H.F.",
    "UHF": "U.H.F.",
    "L-band": "L band",
    "S-band": "S band",
    "C-band": "C band",
    "X-band": "X band",
    "Ku-band": "K.U. band",
    "K-band": "K band",
    "Ka-band": "kay-ay band",
    "V-band": "V band",
    "W-band": "W band",
    "Q-band": "Q band",
    "E-band": "E band",
    "D-band": "D band",
    "G-band": "G band",
    # --- Systems engineering ---
    "SE": "S.E.",
    "MBSE": "M.B.S.E.",
    "SETR": "systems engineering technical review",
    "INCOSE": "in-co-see",
    "SOI": "system of interest",
    "SOS": "system of systems",
    "SoS": "system of systems",
    # SE processes & concepts
    "RVTM": "requirements verification traceability matrix",
    "RTM": "requirements traceability matrix",
    "CONOPS": "con-ops",
    "ICD": "I.C.D.",
    "SRS": "S.R.S.",
    "SSS": "S.S.S.",
    "MOE": "measure of effectiveness",
    "MOP": "measure of performance",
    "MOS": "measure of suitability",
    "KPP": "key performance parameter",
    "KSA": "key system attribute",
    "TPM": "technical performance measure",
    "CDD": "capability development document",
    "CPD": "capability production document",
    "SOW": "statement of work",
    "SOO": "statement of objectives",
    "WBS": "work breakdown structure",
    "PBS": "product breakdown structure",
    "FBS": "functional breakdown structure",
    "BOM": "bill of materials",
    "FMEA": "F.M.E.A.",
    "FMECA": "F.M.E.C.A.",
    "FTA": "fault tree analysis",
    "RBD": "reliability block diagram",
    # SE reviews & milestones
    "ASR": "alternative systems review",
    "SFR": "system functional review",
    "SRR": "S.R.R.",
    "PDR": "P.D.R.",
    "CDR": "C.D.R.",
    "TRR": "test readiness review",
    "FCA": "functional configuration audit",
    "PCA": "physical configuration audit",
    "SVR": "system verification review",
    "PRR": "production readiness review",
    "MRR": "mission readiness review",
    "IBR": "integrated baseline review",
    "TRL": "technology readiness level",
    "MRL": "manufacturing readiness level",
    "IRL": "integration readiness level",
    "SRL": "system readiness level",
    # DoDAF views
    "DODAF": "doh-daf",
    "DoDAF": "doh-daf",
    "AV": "all view",
    "OV": "operational view",
    "SV": "systems view",
    "CV": "capability view",
    "DIV": "data and information view",
    "PV": "project view",
    # SysML / UML diagrams
    "SYSML": "sis-M.L.",
    "SysML": "sis-M.L.",
    "UML": "U.M.L.",
    "BDD": "block definition diagram",
    "IBD": "internal block diagram",
    "STM": "state machine diagram",
    "FFBD": "functional flow block diagram",
    "DFD": "data flow diagram",
    "ERD": "entity relationship diagram",
    "CIR": "canonical internal representation",
    # Modeling & architecture frameworks
    "TOGAF": "toe-gaf",
    "UAF": "U.A.F.",
    "UPDM": "U.P.D.M.",
    "MDA": "M.D.A.",
    "MOF": "M.O.F.",
    "XMI": "X.M.I.",
    "DMN": "D.M.N.",
    "BPMN": "B.P.M.N.",
    # V&V / test
    "VV": "V. and V.",
    "IV": "independent verification",
    "IVV": "independent verification and validation",
    "DT": "developmental test",
    "OT": "operational test",
    "IOC": "initial operational capability",
    "FOC": "full operational capability",
    "LRIP": "low-rate initial production",
    "FRP": "full-rate production",
    # Project management
    "PM": "program manager",
    "PMO": "program management office",
    "PMP": "project management professional",
    "IPT": "integrated product team",
    "EVM": "earned value management",
    "EVMS": "earned value management system",
    "CPI": "cost performance index",
    "SPI": "schedule performance index",
    "EAC": "estimate at completion",
    "ETC": "estimate to complete",
    "BAC": "budget at completion",
    "BOE": "basis of estimate",
    "BCWS": "budgeted cost of work scheduled",
    "BCWP": "budgeted cost of work performed",
    "ACWP": "actual cost of work performed",
    "POAM": "plan of action and milestones",
    "ROI": "return on investment",
    "IRR": "internal rate of return",
    "NPV": "net present value",
    "LOE": "level of effort",
    "IMP": "integrated master plan",
    "IMS": "integrated master schedule",
    "CDRL": "contract data requirements list",
    "DID": "data item description",
    "RFP": "request for proposal",
    "RFI": "request for information",
    "RFQ": "request for quote",
    "CLIN": "contract line item number",
    "NTE": "not to exceed",
    "FFP": "firm fixed price",
    "CPFF": "cost plus fixed fee",
    "CPIF": "cost plus incentive fee",
    "FPIF": "fixed price incentive fee",
    # Configuration & change management
    "CM": "configuration management",
    "CCB": "configuration control board",
    "ECR": "engineering change request",
    "ECN": "engineering change notice",
    "ECP": "engineering change proposal",
    "CI": "configuration item",
    "CSCI": "computer software configuration item",
    "HWCI": "hardware configuration item",
    # Risk management
    "RMP": "risk management plan",
    "POA": "plan of action",
    # --- Space systems / astrodynamics ---
    "MOI": "moment of inertia",
    "COG": "center of gravity",
    "CG": "center of gravity",
    "COM": "center of mass",
    "GNC": "guidance navigation and control",
    "AOCS": "attitude and orbit control system",
    "ADCS": "attitude determination and control system",
    "ACS": "attitude control system",
    "IMU": "inertial measurement unit",
    "INS": "inertial navigation system",
    "GPS": "global positioning system",
    "GNSS": "global navigation satellite system",
    "TLE": "two-line element",
    "COE": "classical orbital elements",
    "LEO": "low Earth orbit",
    "MEO": "medium Earth orbit",
    "GEO": "geostationary orbit",
    "HEO": "highly elliptical orbit",
    "SSO": "sun-synchronous orbit",
    "GTO": "geostationary transfer orbit",
    "TLI": "trans-lunar injection",
    "TMI": "trans-Mars injection",
    "LOI": "lunar orbit insertion",
    "EDL": "entry descent and landing",
    "RAAN": "right ascension of the ascending node",
    "SMA": "semi-major axis",
    "ECC": "eccentricity",
    "INC": "inclination",
    "AOP": "argument of periapsis",
    "SRP": "solar radiation pressure",
    "LVLH": "local vertical local horizontal",
    "ECI": "Earth-centered inertial",
    "ECEF": "Earth-centered Earth-fixed",
    # Launch / propulsion
    "ISP": "specific impulse",
    "SRB": "solid rocket booster",
    "OMS": "orbital maneuvering system",
    "MES": "main engine start",
    "MECO": "main engine cutoff",
    "SECO": "second engine cutoff",
    "BECO": "booster engine cutoff",
    "LOX": "liquid oxygen",
    "LH2": "liquid hydrogen",
    "LCH4": "liquid methane",
    "MMH": "monomethylhydrazine",
    "NTO": "nitrogen tetroxide",
    "METHALOX": "methalox",
    "RP1": "R.P. one",
    # Spacecraft subsystems
    "CDH": "command and data handling",
    "EPS": "electrical power system",
    "TTC": "telemetry tracking and command",
    "TCS": "thermal control system",
    "MLI": "multi-layer insulation",
    "OBDH": "onboard data handling",
    "PDU": "power distribution unit",
    "RTG": "radioisotope thermoelectric generator",
    # Mission / operations
    "MCC": "mission control center",
    "MOC": "mission operations center",
    "SOC": "satellite operations center",
    "EVA": "extravehicular activity",
    "IVA": "intravehicular activity",
    "ECLSS": "environmental control and life support system",
    "ISRU": "in-situ resource utilization",
    "PDL": "payload data link",
    "TMTC": "telemetry and telecommand",
    "CCSDS": "consultative committee for space data systems",
    # Space environment / physics
    "SEE": "single event effect",
    "SEU": "single event upset",
    "TID": "total ionizing dose",
    "NIEL": "non-ionizing energy loss",
    "GCR": "galactic cosmic rays",
    "SPE": "solar particle event",
    "CME": "coronal mass ejection",
    "SAA": "South Atlantic anomaly",
    "BRDF": "bidirectional reflectance distribution function",
    # Comm / link budget
    "TWTA": "traveling wave tube amplifier",
    "SSPA": "solid state power amplifier",
    "LNA": "low noise amplifier",
    "BPF": "bandpass filter",
    "PLL": "phase locked loop",
    "QPSK": "quadrature phase shift keying",
    "BPSK": "binary phase shift keying",
    "OFDM": "orthogonal frequency division multiplexing",
    "FDMA": "frequency division multiple access",
    "TDMA": "time division multiple access",
    "CDMA": "code division multiple access",
}

_ISR_PATTERN = re.compile(
    r"\b("
    + "|".join(re.escape(t) for t in sorted(_ISR_TERMS.keys(), key=len, reverse=True))
    + r")\b"
)


def _expand_isr_term(match: re.Match) -> str:
    return _ISR_TERMS.get(match.group(1), match.group(0))


# --- Symbol expansion ---

_SYMBOLS: dict[str, str] = {"=": "equals", "+": "plus", "&": "and", "@": "at", "#": "number"}

_SYMBOL_PATTERN = re.compile(
    r"(?<!\w)(" + "|".join(re.escape(s) for s in _SYMBOLS.keys()) + r")(?!\w)"
)


def _expand_symbol(match: re.Match) -> str:
    return _SYMBOLS.get(match.group(1), match.group(0))


# --- Main normalize function ---


def normalize_text(text: str) -> str:
    """
    Normalize text for TTS consumption.

    Converts numbers, units, abbreviations, currencies, etc. into
    speakable words. Designed to be called before SentencePiece tokenization.

    Args:
        text: Raw input text.

    Returns:
        Normalized text ready for tokenization.
    """
    # 1. Expand abbreviations first (before we mess with punctuation)
    text = _ABBREV_PATTERN.sub(_expand_abbreviation, text)

    # 2a. Currency with magnitude words ($3.5 billion, €12 million)
    text = _CURRENCY_MAGNITUDE_PATTERN.sub(_expand_currency_magnitude, text)

    # 2b. Simple currency ($100, $3.50)
    text = _CURRENCY_PATTERN.sub(_expand_currency, text)

    # 3. Percentages
    text = _PERCENT_PATTERN.sub(_expand_percent, text)

    # 4. Time notation (3:30 -> three thirty)
    text = _TIME_PATTERN.sub(_expand_time, text)

    # 5. Ordinals (1st, 2nd, etc.)
    text = _ORDINAL_PATTERN.sub(_expand_ordinal, text)

    # 6. Fractions (1/2, 3/4)
    text = _FRACTION_PATTERN.sub(_expand_fraction, text)

    # 7. Numbers with units (17.5mm -> seventeen point five millimeters)
    text = _UNIT_PATTERN.sub(_expand_number_with_unit, text)

    # 7b. Standalone units without numbers (per kg -> per kilograms)
    text = _STANDALONE_UNIT_PATTERN.sub(_expand_standalone_unit, text)

    # 8. Remaining standalone numbers
    text = _NUMBER_PATTERN.sub(_expand_standalone_number, text)

    # 9. Domain-specific terms: ISR, SE, DoDAF, SysML, PM (before generic acronym expander)
    text = _ISR_PATTERN.sub(_expand_isr_term, text)

    # 10. Expand remaining acronyms (FBI -> F.B.I.)
    text = _ACRONYM_PATTERN.sub(_expand_acronym, text)

    # 11. Expand symbols (=, +, &, @, #)
    text = _SYMBOL_PATTERN.sub(_expand_symbol, text)

    # 12. Clean up multiple spaces
    text = re.sub(r" {2,}", " ", text)

    return text.strip()


# --- Pause marker parsing ---

_PAUSE_MARKER_RE = re.compile(r"\[(\d+(?:\.\d+)?)s\]", re.IGNORECASE)
MAX_PAUSE_SECONDS = 10.0


def parse_pause_markers(text: str) -> list[str | float]:
    """Split text on ``[Xs]`` pause markers into text segments and pause durations.

    Must be called **before** :func:`normalize_text` so the numbers inside
    markers are not expanded to words.

    Args:
        text: Input text potentially containing pause markers like ``[2s]``, ``[0.5s]``.

    Returns:
        List of alternating ``str`` (text segments) and ``float`` (pause seconds).
        Empty/whitespace text segments are omitted.  Durations are clamped to
        ``[0, MAX_PAUSE_SECONDS]``; zero-duration pauses are dropped.

    Examples:
        >>> parse_pause_markers("Hello. [2.0s] World.")
        ['Hello. ', 2.0, ' World.']
        >>> parse_pause_markers("No pauses here.")
        ['No pauses here.']
    """
    segments: list[str | float] = []
    last_end = 0

    for m in _PAUSE_MARKER_RE.finditer(text):
        before = text[last_end : m.start()]
        if before.strip():
            segments.append(before)

        duration = min(float(m.group(1)), MAX_PAUSE_SECONDS)
        if duration > 0:
            segments.append(duration)

        last_end = m.end()

    tail = text[last_end:]
    if tail.strip():
        segments.append(tail)

    return segments if segments else [text]
