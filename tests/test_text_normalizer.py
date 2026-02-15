"""
Tests for pocket_tts.text_normalizer

Validates that the normalizer converts numbers, units, abbreviations,
currencies, etc. into speakable words for TTS consumption.
"""

import time

import pytest

from pocket_tts.text_normalizer import normalize_text


# ── Units ──────────────────────────────────────────────────────────────

class TestUnits:
    def test_decimal_with_unit(self):
        """The original bug: '17.5mm' was pronounced '17 five millimeters'."""
        result = normalize_text("17.5mm")
        assert "seventeen point five millimeters" == result

    def test_integer_with_unit(self):
        result = normalize_text("100kg")
        assert "one hundred kilograms" in result

    def test_singular_unit(self):
        result = normalize_text("1km")
        assert "one kilometer" in result
        assert "kilometers" not in result

    def test_unit_with_space(self):
        result = normalize_text("50 mph")
        assert "fifty miles per hour" in result

    def test_data_units_bits(self):
        """Lowercase b = bits by convention."""
        result = normalize_text("10gb")
        assert "ten gigabits" in result

    def test_data_units_bytes(self):
        """Uppercase B = bytes by convention."""
        result = normalize_text("10GB")
        assert "ten gigabytes" in result

    def test_kb_vs_KB(self):
        result_bits = normalize_text("500kb")
        result_bytes = normalize_text("500KB")
        assert "kilobits" in result_bits
        assert "kilobytes" in result_bytes

    def test_frequency_units(self):
        result = normalize_text("2.4ghz")
        assert "two point four gigahertz" in result

    def test_temperature_celsius(self):
        result = normalize_text("37°C")
        assert "thirty-seven degrees Celsius" in result

    # --- Bug fix: irregular plural singularization ---

    def test_singular_foot(self):
        """Bug: 1ft was 'one feet' — must be 'one foot'."""
        result = normalize_text("1ft")
        assert "one foot" in result
        assert "feet" not in result

    def test_singular_inch(self):
        """Bug: 1 in was 'one inche' — must be 'one inch'."""
        result = normalize_text("1 in")
        assert "one inch" in result
        assert "inche" not in result

    def test_singular_hertz(self):
        """Hertz is the same singular and plural."""
        result = normalize_text("1 hz")
        assert "one hertz" in result

    def test_plural_feet(self):
        result = normalize_text("2ft")
        assert "two feet" in result

    def test_plural_inches(self):
        result = normalize_text("5 in")
        assert "five inches" in result

    def test_singular_speed_unit(self):
        result = normalize_text("1 fps")
        assert "one foot per second" in result

    def test_plural_speed_unit(self):
        result = normalize_text("10 fps")
        assert "ten feet per second" in result

    # --- Standalone units (no preceding number) ---

    def test_standalone_kg(self):
        """Bug: 'per kg' was pronounced 'k g' by the model."""
        result = normalize_text("per kg")
        assert "kilograms" in result

    def test_standalone_ghz(self):
        result = normalize_text("per ghz")
        assert "gigahertz" in result

    def test_standalone_rpm(self):
        result = normalize_text("the rpm")
        assert "revolutions per minute" in result

    def test_standalone_no_false_positive(self):
        """Multi-char units inside words must not be expanded."""
        result = normalize_text("package")
        assert result == "package"


# ── Abbreviations ──────────────────────────────────────────────────────

class TestAbbreviations:
    def test_title_abbreviation(self):
        result = normalize_text("Dr. Smith")
        assert "Doctor Smith" in result

    def test_month_abbreviation(self):
        result = normalize_text("Jan. 15th")
        assert "January" in result

    def test_versus(self):
        result = normalize_text("team A vs. team B")
        assert "versus" in result

    def test_multiple_abbreviations(self):
        result = normalize_text("Dr. Smith and Prof. Jones")
        assert "Doctor" in result
        assert "Professor" in result

    # --- Bug fix: uppercase abbreviation matching ---

    def test_uppercase_vs(self):
        """Bug: 'VS.' was not matched, fell through to acronym expander."""
        result = normalize_text("team A VS. team B")
        assert "versus" in result
        assert "V.S." not in result

    def test_uppercase_approx(self):
        result = normalize_text("APPROX. 500")
        assert "approximately" in result

    def test_uppercase_etc(self):
        result = normalize_text("and so on ETC.")
        assert "etcetera" in result


# ── Numbers ────────────────────────────────────────────────────────────

class TestNumbers:
    def test_integer(self):
        result = normalize_text("There are 42 items.")
        assert "forty-two" in result

    def test_decimal(self):
        result = normalize_text("Pi is about 3.14.")
        assert "three point one four" in result

    def test_negative_number(self):
        result = normalize_text("The temperature is -5 degrees.")
        assert "minus five" in result

    def test_large_number(self):
        result = normalize_text("The population is 1000000.")
        assert "one million" in result


# ── Ordinals ───────────────────────────────────────────────────────────

class TestOrdinals:
    def test_first(self):
        result = normalize_text("He came in 1st place.")
        assert "first" in result

    def test_second(self):
        result = normalize_text("The 2nd attempt.")
        assert "second" in result

    def test_third(self):
        result = normalize_text("The 3rd floor.")
        assert "third" in result

    def test_higher_ordinal(self):
        result = normalize_text("The 21st century.")
        assert "twenty-first" in result


# ── Currency ───────────────────────────────────────────────────────────

class TestCurrency:
    def test_dollars(self):
        result = normalize_text("It costs $100.")
        assert "one hundred dollars" in result

    def test_dollars_with_cents(self):
        result = normalize_text("It costs $3.50.")
        assert "three dollars" in result
        assert "fifty cents" in result

    def test_one_dollar(self):
        result = normalize_text("Only $1.")
        assert "one dollar" in result
        assert "dollars" not in result

    def test_euros(self):
        result = normalize_text("€50")
        assert "fifty euros" in result

    def test_pounds(self):
        result = normalize_text("£20")
        assert "twenty pounds" in result


# ── Percentages ────────────────────────────────────────────────────────

class TestPercentages:
    def test_integer_percent(self):
        result = normalize_text("50% complete.")
        assert "fifty percent" in result

    def test_decimal_percent(self):
        result = normalize_text("3.5% growth.")
        assert "three point five percent" in result


# ── Time ───────────────────────────────────────────────────────────────

class TestTime:
    def test_time_on_the_hour(self):
        result = normalize_text("Meet at 3:00.")
        assert "three o'clock" in result

    def test_time_with_minutes(self):
        result = normalize_text("It's 3:30 now.")
        assert "three thirty" in result

    def test_time_oh_minutes(self):
        result = normalize_text("Wake up at 6:05.")
        assert "six oh five" in result


# ── Fractions ──────────────────────────────────────────────────────────

class TestFractions:
    def test_common_half(self):
        result = normalize_text("about 1/2 done")
        assert "one half" in result

    def test_common_quarter(self):
        result = normalize_text("3/4 full")
        assert "three quarters" in result

    def test_uncommon_fraction(self):
        result = normalize_text("2/7 of the group")
        assert "two sevenths" in result


# ── Acronyms ──────────────────────────────────────────────────────────

class TestAcronyms:
    def test_spelled_out(self):
        result = normalize_text("The FBI investigated.")
        assert "F.B.I." in result

    def test_pronounceable_kept(self):
        result = normalize_text("NASA launched a rocket.")
        assert "NASA" in result
        assert "N.A.S.A." not in result

    def test_gpu(self):
        result = normalize_text("This GPU is fast.")
        assert "G.P.U." in result


# ── Symbols ───────────────────────────────────────────────────────────

class TestSymbols:
    def test_equals(self):
        result = normalize_text("x = 5")
        assert "equals" in result

    def test_plus(self):
        result = normalize_text("A + B")
        assert "plus" in result

    def test_ampersand(self):
        result = normalize_text("R & D")
        assert "and" in result

    def test_at_sign(self):
        result = normalize_text("email @ domain")
        assert "at" in result

    def test_hash(self):
        result = normalize_text("issue # 42")
        assert "number" in result

    def test_symbol_in_context(self):
        result = normalize_text("The answer = 42.")
        assert "equals" in result
        assert "forty-two" in result


# ── Apostrophes (don't) ──────────────────────────────────────────────

class TestApostrophes:
    def test_dont_passthrough(self):
        """The normalizer should NOT mangle contractions."""
        result = normalize_text("I don't know.")
        assert "don't" in result or "dont" in result.lower()

    def test_its_passthrough(self):
        result = normalize_text("It's a test.")
        assert "It's" in result or "it's" in result.lower()


# ── End-to-end mixed input ────────────────────────────────────────────

class TestEndToEnd:
    def test_mixed_sentence(self):
        """Realistic TTS input with multiple normalizable elements."""
        result = normalize_text(
            "Dr. Smith measured 17.5mm at 3:30 and it cost $42.50."
        )
        assert "Doctor Smith" in result
        assert "seventeen point five millimeters" in result
        assert "three thirty" in result
        assert "forty-two dollars" in result
        assert "fifty cents" in result

    def test_plain_text_unchanged(self):
        """Plain English text should pass through mostly untouched."""
        text = "The quick brown fox jumps over the lazy dog."
        result = normalize_text(text)
        assert result == text

    def test_empty_string(self):
        result = normalize_text("")
        assert result == ""


# ── Performance ───────────────────────────────────────────────────────

class TestPerformance:
    def test_latency_under_1ms(self):
        """Normalizer must not add meaningful latency to the TTS pipeline."""
        text = (
            "Dr. Smith measured 17.5mm at 3:30 on Jan. 15th. "
            "It cost $42.50, which was 15% over budget. "
            "The FBI investigated 3 cases totaling $1000000."
        )
        # Warm up
        normalize_text(text)

        iterations = 1000
        start = time.perf_counter()
        for _ in range(iterations):
            normalize_text(text)
        elapsed = time.perf_counter() - start

        avg_us = (elapsed / iterations) * 1_000_000
        print(f"\nAvg normalization time: {avg_us:.1f} µs per call")
        # Should be well under 1ms (1000µs). Typical is <100µs.
        assert avg_us < 1000, f"Normalization too slow: {avg_us:.1f} µs"
