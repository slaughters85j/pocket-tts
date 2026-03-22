#!/usr/bin/env python3
"""
Analyze WAV files to compare normalization strategies.

Usage:
    uv run python scripts/analyze-normalization.py per_voice.wav match_quietest.wav match_loudest.wav

    # Or analyze a single file:
    uv run python scripts/analyze-normalization.py output.wav

Computes overall and windowed RMS/peak levels to verify that normalization
strategies produce the expected loudness differences.
"""

import sys
import wave
from pathlib import Path

import numpy as np


def read_wav(path: str) -> tuple[np.ndarray, int]:
    """Read a WAV file and return (samples_float32, sample_rate)."""
    with wave.open(path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sampwidth == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 4:
        samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported sample width: {sampwidth}")

    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)

    return samples, sample_rate


def rms_db(samples: np.ndarray) -> float:
    """Compute RMS level in dB (relative to full scale)."""
    rms = np.sqrt(np.mean(samples**2))
    if rms < 1e-10:
        return -100.0
    return 20 * np.log10(rms)


def peak_db(samples: np.ndarray) -> float:
    """Compute peak level in dB (relative to full scale)."""
    peak = np.max(np.abs(samples))
    if peak < 1e-10:
        return -100.0
    return 20 * np.log10(peak)


def windowed_rms(samples: np.ndarray, sample_rate: int, window_sec: float = 1.0) -> list[float]:
    """Compute RMS in dB over sliding windows."""
    window_size = int(sample_rate * window_sec)
    hop = window_size // 2  # 50% overlap
    results = []
    for start in range(0, len(samples) - window_size + 1, hop):
        chunk = samples[start : start + window_size]
        results.append(rms_db(chunk))
    return results


def analyze_file(path: str) -> dict:
    """Analyze a single WAV file."""
    samples, sr = read_wav(path)
    duration = len(samples) / sr
    overall_rms = rms_db(samples)
    overall_peak = peak_db(samples)
    windowed = windowed_rms(samples, sr, window_sec=1.0)

    return {
        "path": path,
        "duration_sec": duration,
        "sample_rate": sr,
        "overall_rms_db": overall_rms,
        "overall_peak_db": overall_peak,
        "windowed_rms_db": windowed,
        "rms_std_db": float(np.std(windowed)) if windowed else 0.0,
        "rms_min_db": float(np.min(windowed)) if windowed else 0.0,
        "rms_max_db": float(np.max(windowed)) if windowed else 0.0,
    }


def print_analysis(info: dict, label: str | None = None) -> None:
    """Pretty-print analysis results."""
    name = label or Path(info["path"]).name
    print(f"\n{'=' * 60}")
    print(f"  {name}")
    print(f"{'=' * 60}")
    print(f"  Duration:     {info['duration_sec']:.1f}s @ {info['sample_rate']} Hz")
    print(f"  Overall RMS:  {info['overall_rms_db']:+.1f} dB")
    print(f"  Overall Peak: {info['overall_peak_db']:+.1f} dB")
    print(f"  Headroom:     {-info['overall_peak_db']:.1f} dB")
    print()
    print(f"  Windowed RMS (1s windows, 50% overlap):")
    print(f"    Min:   {info['rms_min_db']:+.1f} dB")
    print(f"    Max:   {info['rms_max_db']:+.1f} dB")
    print(f"    Range: {info['rms_max_db'] - info['rms_min_db']:.1f} dB")
    print(f"    StdDev: {info['rms_std_db']:.2f} dB  ", end="")

    # Interpret consistency
    if info["rms_std_db"] < 1.5:
        print("(very consistent)")
    elif info["rms_std_db"] < 3.0:
        print("(moderate variation)")
    else:
        print("(high variation — speakers likely at different levels)")

    # Show windowed RMS timeline
    if info["windowed_rms_db"]:
        print()
        print(f"  Timeline (each bar = 1s window):")
        min_val = min(info["windowed_rms_db"])
        max_val = max(info["windowed_rms_db"])
        range_val = max(max_val - min_val, 0.1)

        for i, db in enumerate(info["windowed_rms_db"]):
            time_str = f"{i * 0.5:5.1f}s"
            bar_len = int(40 * (db - min_val) / range_val) if range_val > 0.1 else 20
            bar = "█" * max(bar_len, 1)
            print(f"    {time_str} │ {bar} {db:+.1f} dB")


def print_comparison(analyses: list[dict], labels: list[str]) -> None:
    """Print side-by-side comparison of multiple files."""
    print(f"\n{'=' * 60}")
    print(f"  COMPARISON SUMMARY")
    print(f"{'=' * 60}")
    print()
    print(f"  {'Strategy':<20} {'RMS':>8} {'Peak':>8} {'StdDev':>8} {'Range':>8}")
    print(f"  {'─' * 20} {'─' * 8} {'─' * 8} {'─' * 8} {'─' * 8}")

    for info, label in zip(analyses, labels):
        rms = f"{info['overall_rms_db']:+.1f}"
        pk = f"{info['overall_peak_db']:+.1f}"
        std = f"{info['rms_std_db']:.2f}"
        rng = f"{info['rms_max_db'] - info['rms_min_db']:.1f}"
        print(f"  {label:<20} {rms:>8} {pk:>8} {std:>8} {rng:>8}")

    print()

    # Highlight key differences
    rms_values = [a["overall_rms_db"] for a in analyses]
    std_values = [a["rms_std_db"] for a in analyses]

    rms_spread = max(rms_values) - min(rms_values)
    print(f"  RMS spread across strategies: {rms_spread:.1f} dB")

    if len(analyses) == 3:
        # Assume order: per_voice, match_quietest, match_loudest
        if std_values[0] > std_values[1] and std_values[0] > std_values[2]:
            print("  ✓ Per-voice has highest variation (expected — different voice levels)")
        if rms_values[1] <= rms_values[0] <= rms_values[2]:
            print("  ✓ Loudness ordering correct: quietest ≤ per-voice ≤ loudest")
        if std_values[1] < std_values[0]:
            print("  ✓ Match-quietest is more consistent than per-voice")
        if std_values[2] < std_values[0]:
            print("  ✓ Match-loudest is more consistent than per-voice")


# ── Validation tests ────────────────────────────────────────────────────────


def _run_tests() -> None:
    """Quick validation of analysis functions."""
    # Test RMS of known signal: 1kHz sine at full scale = 0 dB peak, -3.01 dB RMS
    sr = 16000
    t = np.linspace(0, 1.0, sr, endpoint=False)
    sine = np.sin(2 * np.pi * 1000 * t).astype(np.float32)

    rms = rms_db(sine)
    assert -3.5 < rms < -2.5, f"Full-scale sine RMS should be ~-3.01 dB, got {rms:.2f}"

    pk = peak_db(sine)
    assert -0.1 < pk < 0.1, f"Full-scale sine peak should be ~0 dB, got {pk:.2f}"

    # Test silence
    silence = np.zeros(sr, dtype=np.float32)
    assert rms_db(silence) == -100.0
    assert peak_db(silence) == -100.0

    # Test half-amplitude sine: should be -6 dB peak, ~-9 dB RMS
    half_sine = sine * 0.5
    half_pk = peak_db(half_sine)
    assert -6.5 < half_pk < -5.5, f"Half-amplitude peak should be ~-6.02 dB, got {half_pk:.2f}"

    # Test windowed RMS returns correct number of windows
    windows = windowed_rms(sine, sr, window_sec=0.5)
    # 1s of audio, 0.5s window, 50% overlap = windows at 0.0, 0.25, 0.5 = 3
    assert len(windows) == 3, f"Expected 3 windows, got {len(windows)}"

    print("All validation tests passed ✓")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    if sys.argv[1] == "--test":
        _run_tests()
        sys.exit(0)

    files = sys.argv[1:]

    # Analyze each file
    analyses = []
    labels = []
    for f in files:
        if not Path(f).exists():
            print(f"Error: {f} not found", file=sys.stderr)
            sys.exit(1)
        info = analyze_file(f)
        analyses.append(info)
        labels.append(Path(f).stem)
        print_analysis(info)

    # If multiple files, show comparison
    if len(analyses) > 1:
        print_comparison(analyses, labels)
