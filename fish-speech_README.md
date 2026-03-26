---
library_name: mlx-audio
tags:
- mlx
- text-to-speech
- speech
- speech generation
- voice cloning
- tts
- mlx-audio
license: other
license_name: fish-audio-research
license_link: https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE
pipeline_tag: text-to-speech
base_model: fishaudio/s2-pro
---

# mlx-community/fish-audio-s2-pro-8bit

This model was converted to MLX format from [`fishaudio/s2-pro`](https://huggingface.co/fishaudio/s2-pro) using mlx-audio version **0.4.0**.

Refer to the [original model card](https://huggingface.co/fishaudio/s2-pro) for more details on the model.

## Model Overview

Fish Audio S2 Pro is a leading text-to-speech model with fine-grained inline control of prosody and emotion. Trained on **10M+ hours** of audio data across **80+ languages**, it combines reinforcement learning alignment with a Dual-Autoregressive architecture.

## Model Metadata

| Attribute | Value |
|-----------|-------|
| Model Size | 5B parameters |
| Tensor Type | BF16, U32 |
| Format | Safetensors, MLX |
| Precision | 8-bit (affine quantization, group_size=64) |
| File Size | ~6.72 GB total (model.safetensors ~4.8 GB, codec.safetensors ~1.9 GB) |
| Task | Text-to-Speech |
| Base Model | [fishaudio/s2-pro](https://huggingface.co/fishaudio/s2-pro) |
| Paper | [Fish Audio S2 Technical Report (arXiv: 2603.08823)](https://arxiv.org/abs/2603.08823) |

## Architecture

S2 Pro builds on a decoder-only transformer combined with an RVQ-based audio codec (10 codebooks, ~21 Hz frame rate) using a Dual-Autoregressive (Dual-AR) architecture:

- **Slow AR (4B parameters):** Operates along the time axis and predicts the primary semantic codebook.
- **Fast AR (400M parameters):** Generates the remaining 9 residual codebooks at each time step, reconstructing fine-grained acoustic detail.

This asymmetric design keeps inference efficient while preserving audio fidelity. Because the Dual-AR architecture is structurally isomorphic to standard autoregressive LLMs, it inherits all LLM-native serving optimizations from SGLang — including continuous batching, paged KV cache, CUDA graph replay, and RadixAttention-based prefix caching.

| Attribute | Value |
|-----------|-------|
| Total Parameters | 5B |
| Slow AR | 4B (time-axis, primary semantic codebook) |
| Fast AR | 400M (residual codebooks per time step) |
| Audio Codec | 10 codebooks @ ~21 Hz frame rate |
| Tensor Type | BF16 |

## Fine-Grained Inline Control

S2 Pro enables localized control over speech generation by embedding natural-language instructions directly within the text using `[tag]` syntax. Rather than relying on a fixed set of predefined tags, S2 Pro accepts free-form textual descriptions — such as `[whisper in small voice]`, `[professional broadcast tone]`, or `[pitch up]` — allowing open-ended expression control at the word level.

```
[whisper in small voice]
[professional broadcast tone]
[pitch up]
```

**Common Tags (15,000+ unique tags supported):**

`[pause]` `[emphasis]` `[laughing]` `[inhale]` `[chuckle]` `[tsk]` `[singing]` `[excited]` `[laughing tone]` `[interrupting]` `[chuckling]` `[excited tone]` `[volume up]` `[echo]` `[angry]` `[low volume]` `[sigh]` `[low voice]` `[whisper]` `[screaming]` `[shouting]` `[loud]` `[surprised]` `[short pause]` `[exhale]` `[delight]` `[panting]` `[audience laughter]` `[with strong accent]` `[volume down]` `[clearing throat]` `[sad]` `[moaning]` `[shocked]`

### Inline Tag Best Practices

Based on local MLX inference testing, the following guidelines produce the most reliable output:

- **One tag per phrase or sentence.** Give the model enough text after a tag to settle into the style before switching. Rapid tag switching every sentence degrades quality.
- **Do not stack tags back-to-back.** Adjacent tags with no text between them (e.g., `[audience laughter][chuckling]`) produce garbled or distorted audio. Separate them with natural text or a full sentence.
- **`[pause]` counts as a tag.** Do not place `[pause]` immediately before another tag — insert text between them.
- **`[singing]` is unreliable.** The model is a TTS system, not a vocoder trained on melodic data. Expect spoken cadence, not actual singing.
- **`[screaming]` causes distortion.** Audio phases out and distorts even with adequate text after the tag. Use `[loud]` or `[troubled]` as safer alternatives for high-intensity delivery.
- **Emotion transitions need runway.** When shifting between emotions, allow at least one full sentence per tag so the Dual-AR architecture can stabilize the new prosody.

**Good:**
```
[excited]I cannot believe this works! After all that effort, we finally have local inference.
[whisper]And the best part is, nobody else knows about it yet.
```

**Bad:**
```
[excited]Wow! [sad]But also sad. [angry]And frustrating! [laughing]Just kidding.
[pause][short pause][excited]Surprise![audience laughter][chuckling]Funny right?
```

## Supported Languages

S2 Pro supports 80+ languages.

**Tier 1 (Full Support):** Japanese (ja), English (en), Chinese (zh)

**Tier 2 (Strong Support):** Korean (ko), Spanish (es), Portuguese (pt), Arabic (ar), Russian (ru), French (fr), German (de)

**Other supported languages:** sv, it, tr, no, nl, cy, eu, ca, da, gl, ta, hu, fi, pl, et, hi, la, ur, th, vi, jw, bn, yo, sl, cs, sw, nn, he, ms, uk, id, kk, bg, lv, my, tl, sk, ne, fa, af, el, bo, hr, ro, sn, mi, yi, am, be, km, is, az, sd, br, sq, ps, mn, ht, ml, sr, sa, te, ka, bs, pa, lt, kn, si, hy, mr, as, gu, fo, and more.

## Production Streaming Performance

On a single NVIDIA H200 GPU:

| Metric | Value |
|--------|-------|
| Real-Time Factor (RTF) | 0.195 |
| Time-to-first-audio | ~100 ms |
| Throughput | 3,000+ acoustic tokens/s (while maintaining RTF below 0.5) |

## Download Model Weights

Install the Hugging Face Hub CLI and download the model:

```bash
pip install -U huggingface_hub
huggingface-cli download mlx-community/fish-audio-s2-pro-8bit --local-dir ./mlx-community/fish-audio-s2-pro-8bit
```

This downloads all model files (~6.72 GB total) to a local directory. To download to the default Hugging Face cache instead, omit the `--local-dir` flag:

```bash
huggingface-cli download mlx-community/fish-audio-s2-pro-8bit
```

> **Note:** The model is gated under the Fish Audio Research License. If prompted, accept the license at [huggingface.co/mlx-community/fish-audio-s2-pro-8bit](https://huggingface.co/mlx-community/fish-audio-s2-pro-8bit) and authenticate with `huggingface-cli login` first.

## Use with mlx-audio

```bash
pip install -U mlx-audio
```

### CLI Example

```bash
python -m mlx_audio.tts.generate --model mlx-community/fish-audio-s2-pro-8bit --text "Hello, this is a test."
```

### Python Example

```python
from mlx_audio.tts.utils import load_model
from mlx_audio.tts.generate import generate_audio

model = load_model("mlx-community/fish-audio-s2-pro-8bit")
generate_audio(
    model=model,
    text="Hello, this is a test.",
    ref_audio="path_to_audio.wav",
    file_prefix="test_audio",
)
```

## Links

- [Fish Speech GitHub](https://github.com/fishaudio/fish-speech)
- [Fish Audio Playground](https://fish.audio)
- [Blog & Tech Report](https://arxiv.org/abs/2603.08823)

## Citation

```bibtex
@misc{liao2026fishaudios2technical,
      title={Fish Audio S2 Technical Report},
      author={Shijia Liao and Yuxuan Wang and Songting Liu and Yifan Cheng and Ruoyi Zhang and Tianyu Li and Shidong Li and Yisheng Zheng and Xingwei Liu and Qingzheng Wang and Zhizhuo Zhou and Jiahua Liu and Xin Chen and Dawei Han},
      year={2026},
      eprint={2603.08823},
      archivePrefix={arXiv},
      primaryClass={cs.SD},
      url={https://arxiv.org/abs/2603.08823},
}
```

## License

This model is released under the **Fish Audio Research License**:

- **Research use:** Free
- **Non-commercial use:** Free
- **Commercial use:** Requires separate license from Fish Audio (contact: business@fish.audio)

See the [original model](https://huggingface.co/fishaudio/s2-pro) for full license details.
