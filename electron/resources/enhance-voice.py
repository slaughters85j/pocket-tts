#!/usr/bin/env python3
"""
Standalone LavaSR voice enhancement script for Pocket TTS.

Spawned as a sidecar subprocess by Electron's main process.
Auto-detects MPS (Apple Silicon GPU) for faster enhancement.

Usage:
    python enhance-voice.py --input voice.wav --output enhanced.wav
    python enhance-voice.py --input voice.wav --output enhanced.wav --no-denoise --device cpu
"""

import argparse
import json
import sys
from pathlib import Path


def emit(status: str, **kwargs):
    """Emit JSON status line to stdout for Electron to parse."""
    msg = {"status": status, **kwargs}
    print(json.dumps(msg), flush=True)


def detect_device(requested: str) -> str:
    """Resolve 'auto' device to best available option."""
    if requested != "auto":
        return requested

    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def enhance_audio(
    input_path: str,
    output_path: str,
    denoise: bool = True,
    device: str = "auto",
    target_sr: int = 24000,
) -> dict:
    """Enhance audio using LavaSR v2 and resample to target sample rate.

    Returns dict with enhancement metadata.
    """
    import soundfile as sf
    import torch
    import torchaudio.functional as F

    device = detect_device(device)
    emit("loading", device=device)

    from LavaSR.model import LavaEnhance2

    model = LavaEnhance2("YatharthS/LavaSR", device)

    emit("enhancing", denoise=denoise)

    input_audio, input_sr = model.load_audio(input_path)
    output_audio = model.enhance(input_audio, denoise=denoise, batch=False)

    # LavaSR always outputs 48kHz
    lavasr_sr = 48000
    output_tensor = output_audio.cpu()

    # Resample to target sample rate for Mimi codec compatibility
    if target_sr != lavasr_sr:
        # Ensure 2D tensor for torchaudio resample: (channels, samples)
        if output_tensor.dim() == 1:
            output_tensor = output_tensor.unsqueeze(0)
        elif output_tensor.dim() == 3:
            output_tensor = output_tensor.squeeze(0)

        output_tensor = F.resample(output_tensor, lavasr_sr, target_sr)
        output_sr = target_sr
    else:
        output_sr = lavasr_sr

    output_np = output_tensor.numpy().squeeze()

    sf.write(output_path, output_np, output_sr)

    emit("done", output_sr=output_sr, device=device, denoise=denoise)

    return {"output_sr": output_sr, "device": device, "denoise": denoise}


def main():
    parser = argparse.ArgumentParser(
        description="Enhance voice sample with LavaSR v2 for Pocket TTS"
    )
    parser.add_argument("--input", required=True, help="Input audio file path")
    parser.add_argument("--output", required=True, help="Output audio file path")
    parser.add_argument(
        "--denoise",
        action="store_true",
        default=True,
        help="Apply denoising (default: True)",
    )
    parser.add_argument(
        "--no-denoise", action="store_false", dest="denoise", help="Disable denoising"
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cpu", "mps", "cuda"],
        help="Device (default: auto = MPS if available, else CPU)",
    )
    parser.add_argument(
        "--target-sr",
        type=int,
        default=24000,
        help="Target sample rate (default: 24000 for Mimi codec)",
    )

    args = parser.parse_args()

    if not Path(args.input).exists():
        emit("error", message=f"Input file not found: {args.input}")
        sys.exit(1)

    try:
        enhance_audio(
            args.input,
            args.output,
            denoise=args.denoise,
            device=args.device,
            target_sr=args.target_sr,
        )
    except Exception as e:
        emit("error", message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
