#!/usr/bin/env python3
"""isobin.py - generate isochronic + binaural beat audio files.

Requires: numpy.  ffmpeg is needed for mp3, flac and opus output (wav is built in).

Output format comes from the file extension: .wav  .mp3  .flac  .opus

Examples
--------
# 20 min WAV: binaural 200 Hz left / 210 Hz right (10 Hz beat), continuous,
# plus one 10 Hz isochronic tone at 300 Hz:
python isobin.py -o session.wav -d 20m

# Binaural tones pulse together with the isochronic beat (same pulse envelope,
# so they fade in and out with every pulse). Carriers stay 200/210 Hz. MP3 @ 192 kbps:
python isobin.py -o session.mp3 -d 20m --binaural 200,210 \
    --binaural-mode sync --iso-beat-freq 10 --bitrate 192k

# Sequence of binaural sections (3 min each, 4 s glides), 3 layered iso tones,
# alternating left/right pulses, FLAC (compression level 8):
python isobin.py -o session.flac -d 30m \
    --binaural 200,212 --binaural 200,208 --binaural 200,206 \
    --binaural-section-duration 3m --binaural-glide 4 \
    --iso-tones 3 --iso-tone-freq 150,300,450 --iso-beat-freq 8 \
    --iso-mode stereo --flac-level 8

# Opus at a 96 kbps target (rendered at 48 kHz, the native Opus rate):
python isobin.py -o session.opus -d 30m --bitrate 96k
"""

import argparse
import os
import shutil
import subprocess
import sys
import wave

import numpy as np

CHUNK = 1 << 20  # samples rendered per block (keeps memory flat for long files)
FORMATS = {".wav": "wav", ".mp3": "mp3", ".flac": "flac", ".opus": "opus"}
FFMPEG_ENCODER = {"mp3": "libmp3lame", "flac": "flac", "opus": "libopus"}
MP3_RATES = {8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000}
OPUS_RATES = {8000, 12000, 16000, 24000, 48000}


# --------------------------------------------------------------------------
# Argument parsing helpers
# --------------------------------------------------------------------------
def parse_time(text):
    """'90', '90s', '1.5m', '2h', '3:30', '1:02:03' -> seconds."""
    s = str(text).strip().lower()
    try:
        if ":" in s:
            parts = [float(p) for p in s.split(":")]
            if len(parts) > 3:
                raise ValueError
            sec = 0.0
            for p in parts:
                sec = sec * 60 + p
            return sec
        if s.endswith("h"):
            return float(s[:-1]) * 3600
        if s.endswith("m"):
            return float(s[:-1]) * 60
        if s.endswith("s"):
            return float(s[:-1])
        return float(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid time value: {text!r}")


def parse_time_list(text):
    return [parse_time(x) for x in text.split(",") if x.strip()]


def parse_float_list(text):
    try:
        vals = [float(x) for x in text.split(",") if x.strip()]
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid number list: {text!r}")
    if not vals:
        raise argparse.ArgumentTypeError("empty list")
    return vals


def parse_carriers(text):
    vals = parse_float_list(text)
    if len(vals) != 2:
        raise argparse.ArgumentTypeError("use F1,F2 (left,right carrier frequencies)")
    return (vals[0], vals[1])


def parse_bitrate(text):
    """'192k', '192', '128000' -> kbps (int)."""
    s = str(text).strip().lower()
    try:
        v = float(s[:-1]) if s.endswith("k") else float(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid bitrate: {text!r}")
    if v >= 1000:
        v /= 1000.0                       # plain bits per second, e.g. 128000
    if v <= 0:
        raise argparse.ArgumentTypeError("bitrate must be positive")
    return int(round(v))


def int_range(lo, hi):
    def conv(text):
        try:
            v = int(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"invalid integer: {text!r}")
        if not lo <= v <= hi:
            raise argparse.ArgumentTypeError(f"must be between {lo} and {hi}")
        return v
    return conv


def unit_float(text):
    v = float(text)
    if not 0.0 <= v <= 1.0:
        raise argparse.ArgumentTypeError("must be between 0 and 1")
    return v


def build_parser():
    p = argparse.ArgumentParser(
        prog="isobin.py",
        description="Generate isochronic and binaural beats simultaneously.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    f = p.add_argument_group("audio file")
    f.add_argument("-o", "--output", required=True, metavar="PATH",
                   help="output file; format is taken from the extension "
                        "(.wav .mp3 .flac .opus)")
    f.add_argument("--format", choices=("wav", "mp3", "flac", "opus"),
                   help="set the format explicitly (appends the extension if missing)")
    f.add_argument("-d", "--duration", required=True, type=parse_time,
                   metavar="TIME", help="length: seconds, 90s, 20m, 1.5h, 3:30, 1:02:03")
    f.add_argument("-a", "--amplitude", type=unit_float, default=0.8, metavar="0-1",
                   help="master amplitude (default 0.8)")
    f.add_argument("--fade-in", type=parse_time, default=5.0, metavar="TIME",
                   help="file fade-in length (default 5s)")
    f.add_argument("--fade-out", type=parse_time, default=5.0, metavar="TIME",
                   help="file fade-out length (default 5s)")
    f.add_argument("--sample-rate", type=int, metavar="HZ",
                   help="sample rate (default 44100; 48000 for opus). "
                        "Opus allows 8000/12000/16000/24000/48000")
    f.add_argument("--bit-depth", type=int, choices=(16, 24),
                   help="bit depth for wav and flac (default 16, with TPDF dither). "
                        "mp3/opus are always encoded from 24-bit")
    f.add_argument("--bitrate", type=parse_bitrate, metavar="KBPS",
                   help="mp3: constant bitrate, 8-320 (default 192). opus: target "
                        "bitrate, 6-510 (default 128). Accepts 192, 192k or 192000")
    f.add_argument("--mp3-vbr-quality", type=int_range(0, 9), metavar="0-9",
                   help="mp3 variable bitrate instead of --bitrate; 0 = best "
                        "(about 245 kbps), 9 = smallest")
    f.add_argument("--opus-vbr", choices=("on", "off", "constrained"),
                   help="opus rate control (default on = VBR around the target bitrate; "
                        "off = constant bitrate)")
    f.add_argument("--flac-level", type=int_range(0, 12), metavar="0-12",
                   help="flac compression level (default 5; lossless at every level)")

    b = p.add_argument_group("binaural beats (stereo headphones required)")
    b.add_argument("--binaural", type=parse_carriers, action="append",
                   metavar="F1,F2",
                   help="carrier frequencies in Hz for left,right. Repeat the option "
                        "to create a sequence of sections. Default: 200,210")
    b.add_argument("--binaural-amplitude", type=unit_float, default=0.5, metavar="0-1",
                   help="binaural level (default 0.5, 0 disables binaural)")
    b.add_argument("--binaural-section-duration", type=parse_time_list, default=[60.0],
                   metavar="TIME[,TIME...]",
                   help="length of each section in a sequence; one value for all, or "
                        "one per section (default 60s). The sequence loops to fill the file")
    b.add_argument("--binaural-glide", type=parse_time, default=0.0, metavar="TIME",
                   help="smooth frequency glide at the start of each section "
                        "(default 0 = instant step; phase is always continuous)")
    b.add_argument("--binaural-mode", choices=("constant", "sync"), default="constant",
                   help="constant: binaural tones play continuously. sync: they are "
                        "gated by the isochronic pulse envelope (same timing and "
                        "fade-in/out as the pulses). F1/F2 are unchanged either way")
    b.add_argument("--binaural-sync-tone", type=int, default=1, metavar="N",
                   help="in sync mode, which isochronic tone (1-based) the binaural "
                        "pulses follow (default 1)")

    i = p.add_argument_group("isochronic beats")
    i.add_argument("--iso-tones", type=int, metavar="N",
                   help="number of simultaneous isochronic tones (default: inferred "
                        "from the lists below)")
    i.add_argument("--iso-beat-freq", type=parse_float_list, default=[10.0],
                   metavar="HZ[,HZ...]",
                   help="pulse rate in Hz; one value for all tones or one per tone "
                        "(default 10)")
    i.add_argument("--iso-tone-freq", type=parse_float_list, default=[300.0],
                   metavar="HZ[,HZ...]",
                   help="tone (carrier) frequency in Hz, one per tone. A single value "
                        "with N>1 builds a harmonic stack f, 2f, 3f... (default 300)")
    i.add_argument("--iso-fade-in-ms", type=float, default=10.0, metavar="MS",
                   help="fade-in of each pulse in ms (default 10)")
    i.add_argument("--iso-fade-out-ms", type=float, default=10.0, metavar="MS",
                   help="fade-out of each pulse in ms (default 10)")
    i.add_argument("--iso-duty", type=float, default=0.5, metavar="0-1",
                   help="fraction of each beat period the tone is on (default 0.5)")
    i.add_argument("--iso-mode", choices=("mono", "stereo"), default="mono",
                   help="mono: same pulses in both ears. stereo: pulses alternate "
                        "left/right (overall pulse rate stays equal to the beat freq)")
    i.add_argument("--iso-amplitude", type=unit_float, default=0.5, metavar="0-1",
                   help="isochronic level (default 0.5, 0 disables isochronic)")

    p.add_argument("-q", "--quiet", action="store_true", help="no progress output")
    return p


# --------------------------------------------------------------------------
# Signal generators
# --------------------------------------------------------------------------
class BinauralGenerator:
    """Phase-continuous sine pair with optional section sequence and glides."""

    def __init__(self, f_left, f_right, durations, glide, sr):
        self.fl = np.asarray(f_left, dtype=np.float64)
        self.fr = np.asarray(f_right, dtype=np.float64)
        self.dur = np.asarray(durations, dtype=np.float64)
        self.ends = np.cumsum(self.dur)
        self.starts = self.ends - self.dur
        self.cycle = float(self.ends[-1])
        self.n = len(self.dur)
        self.glide = glide
        self.sr = sr
        self.phase = [0.0, 0.0]

    def _freq(self, table, t, tt, idx, local):
        cur = table[idx]
        if self.glide > 0 and self.n > 1:
            a = np.clip(local / self.glide, 0.0, 1.0)
            a = a * a * (3 - 2 * a)                    # smoothstep
            a = np.where(t < self.dur[0], 1.0, a)      # no glide-in at file start
            prev = table[(idx - 1) % self.n]
            return prev + (cur - prev) * a
        return cur

    def render(self, t):
        tt = np.mod(t, self.cycle)
        idx = np.minimum(np.searchsorted(self.ends, tt, side="right"), self.n - 1)
        local = tt - self.starts[idx]
        out = np.empty((len(t), 2))
        for ch, table in enumerate((self.fl, self.fr)):
            f = self._freq(table, t, tt, idx, local)
            inc = 2 * np.pi * f / self.sr
            ph = self.phase[ch] + np.cumsum(inc) - inc
            out[:, ch] = np.sin(ph)
            self.phase[ch] = (self.phase[ch] + inc.sum()) % (2 * np.pi)
        return out


def pulse_envelope(t, beat, duty, rin, rout):
    """Raised-cosine-edged gate at `beat` Hz. Returns (envelope, period index)."""
    pos = t * beat
    k = np.floor(pos)
    tau = (pos - k) / beat                  # seconds into the current period
    on = duty / beat
    env = (tau < on).astype(np.float64)
    if rin > 0:
        x = np.clip(tau / rin, 0.0, 1.0)
        env *= 0.5 * (1 - np.cos(np.pi * x))
    if rout > 0:
        x = np.clip((tau - (on - rout)) / rout, 0.0, 1.0)
        env *= 0.5 * (1 + np.cos(np.pi * x))
    return env, k.astype(np.int64)


def render_isochronic(t, tones, beats, duty, rin, rout, stereo):
    left = np.zeros(len(t))
    right = np.zeros(len(t))
    for f, beat in zip(tones, beats):
        carrier = np.sin(2 * np.pi * np.mod(f * t, 1.0))
        env, k = pulse_envelope(t, beat, duty, rin, rout)
        sig = carrier * env
        if stereo:
            even = (k % 2 == 0)
            left += np.where(even, sig, 0.0)
            right += np.where(even, 0.0, sig)
        else:
            left += sig
            right += sig
    n = len(tones)
    return np.stack((left / n, right / n), axis=1)


def fade_gain(idx, total, fin, fout):
    g = np.ones(len(idx))
    if fin > 0:
        x = np.clip((idx + 0.5) / fin, 0.0, 1.0)
        g *= 0.5 * (1 - np.cos(np.pi * x))
    if fout > 0:
        x = np.clip((total - idx - 0.5) / fout, 0.0, 1.0)
        g *= 0.5 * (1 - np.cos(np.pi * x))
    return g


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------
def to_pcm(block, bits, rng):
    """Float block (n, 2) in [-1, 1] -> interleaved little-endian PCM bytes."""
    if bits == 16:
        scaled = block * 32767.0
        scaled += rng.random(block.shape) - rng.random(block.shape)  # TPDF dither
        pcm = np.clip(np.rint(scaled), -32768, 32767).astype("<i2")
        return pcm.tobytes()
    scaled = np.clip(np.rint(block * 8388607.0), -8388608, 8388607).astype("<i4")
    return scaled.reshape(-1).view(np.uint8).reshape(-1, 4)[:, :3].tobytes()


class WavSink:
    def __init__(self, path, bits, sr):
        self.w = wave.open(path, "wb")
        self.w.setnchannels(2)
        self.w.setsampwidth(bits // 8)
        self.w.setframerate(sr)

    def write(self, data):
        self.w.writeframes(data)

    def close(self):
        self.w.close()

    abort = close


class FfmpegSink:
    """Streams raw PCM into ffmpeg's stdin; no temporary file is needed."""

    def __init__(self, cmd):
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, data):
        try:
            self.proc.stdin.write(data)
        except BrokenPipeError:
            self.close()
            raise RuntimeError("ffmpeg closed its input early")

    def close(self):
        try:
            self.proc.stdin.close()
        except BrokenPipeError:
            pass
        msg = self.proc.stderr.read().decode(errors="replace").strip()
        if self.proc.wait() != 0:
            raise RuntimeError(f"ffmpeg failed: {msg}")

    def abort(self):
        self.proc.kill()
        self.proc.wait()


def resolve_format(args, err):
    ext = os.path.splitext(args.output)[1].lower()
    if args.format:
        if ext and FORMATS.get(ext) != args.format:
            err(f"output extension {ext!r} does not match --format {args.format}")
        out = args.output if ext else f"{args.output}.{args.format}"
        return args.format, out
    if ext in FORMATS:
        return FORMATS[ext], args.output
    err("unrecognised output extension; use .wav, .mp3, .flac or .opus "
        "(or pass --format)")


def check_encoder(fmt, err):
    exe = shutil.which("ffmpeg")
    if not exe:
        err(f"{fmt} output needs ffmpeg on PATH (or choose a .wav output)")
    try:
        out = subprocess.run([exe, "-hide_banner", "-encoders"],
                             capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        err("could not run ffmpeg")
    enc = FFMPEG_ENCODER[fmt]
    if enc not in out.split():
        err(f"this ffmpeg build has no {enc} encoder, so {fmt} output is unavailable")
    return exe


def ffmpeg_command(exe, fmt, args, sr, bits, out_path):
    raw = "s16le" if bits == 16 else "s24le"
    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-nostats",
           "-f", raw, "-ar", str(sr), "-ac", "2", "-i", "pipe:0"]
    if fmt == "mp3":
        cmd += ["-c:a", "libmp3lame"]
        if args.mp3_vbr_quality is not None:
            cmd += ["-q:a", str(args.mp3_vbr_quality)]
        else:
            cmd += ["-b:a", f"{args.bitrate or 192}k"]
    elif fmt == "opus":
        cmd += ["-c:a", "libopus", "-b:a", f"{args.bitrate or 128}k",
                "-vbr", args.opus_vbr or "on"]
    elif fmt == "flac":
        level = 5 if args.flac_level is None else args.flac_level
        cmd += ["-c:a", "flac", "-compression_level", str(level)]
    cmd.append(out_path)
    return cmd


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
class Cancelled(Exception):
    pass


def main(argv=None, cancel=None):
    """Run the generator. `cancel` may be a threading.Event (used by the GUI).

    Returns True when the file was written, False if it was cancelled."""
    parser = build_parser()
    args = parser.parse_args(argv)
    err = parser.error

    fmt, out_path = resolve_format(args, err)
    lossy = fmt in ("mp3", "opus")
    sr = args.sample_rate or (48000 if fmt == "opus" else 44100)
    nyq = sr / 2.0
    bits = 24 if lossy else (args.bit_depth or 16)

    if args.duration <= 0:
        err("--duration must be positive")
    if sr < 8000 or sr > 192000:
        err("--sample-rate must be between 8000 and 192000")
    if fmt == "opus" and sr not in OPUS_RATES:
        err("opus supports only 8000, 12000, 16000, 24000 or 48000 Hz (use 48000)")
    if fmt == "mp3" and sr not in MP3_RATES:
        err("mp3 supports 8000-48000 Hz standard rates (e.g. 44100 or 48000)")
    if args.fade_in < 0 or args.fade_out < 0:
        err("fades cannot be negative")
    if args.fade_in + args.fade_out > args.duration:
        err("fade-in + fade-out is longer than the file")

    # ---- format options ---------------------------------------------------
    ffmpeg_exe = check_encoder(fmt, err) if fmt != "wav" else None
    for flag, val, applies in (
            ("--bitrate", args.bitrate, lossy),
            ("--mp3-vbr-quality", args.mp3_vbr_quality, fmt == "mp3"),
            ("--opus-vbr", args.opus_vbr, fmt == "opus"),
            ("--flac-level", args.flac_level, fmt == "flac"),
            ("--bit-depth", args.bit_depth, fmt in ("wav", "flac"))):
        if val is not None and not applies:
            print(f"note: {flag} has no effect for {fmt} output; ignored",
                  file=sys.stderr)
    if args.bitrate is not None:
        if fmt == "mp3" and not 8 <= args.bitrate <= 320:
            err("mp3 bitrate must be between 8 and 320 kbps")
        if fmt == "opus" and not 6 <= args.bitrate <= 510:
            err("opus bitrate must be between 6 and 510 kbps")
    if fmt == "mp3" and args.mp3_vbr_quality is not None and args.bitrate is not None:
        err("use either --bitrate or --mp3-vbr-quality, not both")

    # ---- isochronic setup -------------------------------------------------
    use_iso = args.iso_amplitude > 0
    beats = list(args.iso_beat_freq)
    tones = list(args.iso_tone_freq)
    n_tones = args.iso_tones or max(len(beats), len(tones))
    if n_tones < 1:
        err("--iso-tones must be at least 1")
    for name, lst in (("--iso-beat-freq", beats), ("--iso-tone-freq", tones)):
        if len(lst) not in (1, n_tones):
            err(f"{name} needs 1 value or exactly {n_tones} values (got {len(lst)})")
    if len(beats) == 1:
        beats = beats * n_tones
    if len(tones) == 1 and n_tones > 1:
        tones = [tones[0] * (k + 1) for k in range(n_tones)]
    if any(b <= 0 for b in beats):
        err("isochronic beat frequencies must be positive")
    if any(f <= 0 or f >= nyq for f in tones):
        err(f"isochronic tone frequencies must be between 0 and {nyq:g} Hz")
    if not 0 < args.iso_duty <= 1:
        err("--iso-duty must be in (0, 1]")
    rin = args.iso_fade_in_ms / 1000.0
    rout = args.iso_fade_out_ms / 1000.0
    if rin < 0 or rout < 0:
        err("pulse fades cannot be negative")
    for b in beats:
        on = args.iso_duty / b
        if rin + rout > on:
            err(f"pulse fades ({rin + rout:.4f}s) exceed the on-time at {b:g} Hz "
                f"({on:.4f}s); shorten the fades or raise --iso-duty")

    # ---- binaural setup ---------------------------------------------------
    use_bin = args.binaural_amplitude > 0
    pairs = args.binaural or [(200.0, 210.0)]
    f_left = [p[0] for p in pairs]
    f_right = [p[1] for p in pairs]
    gate_k = None
    if args.binaural_mode == "sync":
        gate_k = args.binaural_sync_tone - 1
        if not 0 <= gate_k < n_tones:
            err(f"--binaural-sync-tone must be between 1 and {n_tones}")
    if use_bin:
        if any(f <= 0 or f >= nyq for f in f_left + f_right):
            err(f"binaural carriers must be between 0 and {nyq:g} Hz")
        durs = list(args.binaural_section_duration)
        if len(durs) == 1:
            durs = durs * len(pairs)
        if len(durs) != len(pairs):
            err("--binaural-section-duration needs 1 value or one per section")
        if any(d <= 0 for d in durs):
            err("section durations must be positive")
        if args.binaural_glide < 0 or (len(pairs) > 1 and args.binaural_glide > min(durs)):
            err("--binaural-glide must be between 0 and the shortest section")
        for a, b in zip(f_left, f_right):
            if abs(a - b) > 30:
                print(f"warning: binaural difference {abs(a - b):g} Hz is large; "
                      "the effect is usually weak above ~30 Hz", file=sys.stderr)

    if not use_iso and not use_bin:
        err("both layers are disabled (amplitudes are 0)")

    # ---- gain staging: worst case peak = master * (b + i) -----------------
    b_amp = args.binaural_amplitude if use_bin else 0.0
    i_amp = args.iso_amplitude if use_iso else 0.0
    worst = args.amplitude * (b_amp + i_amp)
    norm = 1.0
    if worst > 1.0:
        norm = 1.0 / worst
        print(f"warning: levels could clip; scaling the mix by {norm:.3f}",
              file=sys.stderr)
    if lossy and worst * norm > 0.89:
        print("warning: lossy encoders can overshoot; peaks above ~0.89 may clip "
              "after decoding. Consider lowering --amplitude", file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    # ---- summary ----------------------------------------------------------
    if not args.quiet:
        if fmt == "mp3":
            detail = (f"VBR V{args.mp3_vbr_quality}" if args.mp3_vbr_quality is not None
                      else f"{args.bitrate or 192} kbps CBR")
        elif fmt == "opus":
            detail = f"{args.bitrate or 128} kbps, vbr {args.opus_vbr or 'on'}"
        elif fmt == "flac":
            detail = f"{bits}-bit, level {5 if args.flac_level is None else args.flac_level}"
        else:
            detail = f"{bits}-bit PCM"
        print(f"output      : {out_path}  ({args.duration:.1f}s, {sr} Hz stereo, "
              f"{fmt}: {detail})", file=sys.stderr)
        if use_bin:
            secs = ", ".join(f"{a:g}/{b:g}" for a, b in zip(f_left, f_right))
            how = ("pulsed with iso tone " + str(gate_k + 1)) if gate_k is not None \
                else "continuous"
            print(f"binaural    : {how}; L/R Hz = {secs}", file=sys.stderr)
        if use_iso:
            print(f"isochronic  : {n_tones} tone(s) {', '.join(f'{f:g}' for f in tones)} Hz, "
                  f"beats {', '.join(f'{b:g}' for b in beats)} Hz, {args.iso_mode}",
                  file=sys.stderr)

    # ---- render -----------------------------------------------------------
    total = int(round(args.duration * sr))
    fin = int(round(args.fade_in * sr))
    fout = int(round(args.fade_out * sr))
    bgen = (BinauralGenerator(f_left, f_right, durs, args.binaural_glide, sr)
            if use_bin else None)
    rng = np.random.default_rng()
    scale = args.amplitude * norm

    if fmt == "wav":
        sink = WavSink(out_path, bits, sr)
    else:
        sink = FfmpegSink(ffmpeg_command(ffmpeg_exe, fmt, args, sr, bits, out_path))

    try:
        for start in range(0, total, CHUNK):
            if cancel is not None and cancel.is_set():
                raise Cancelled()
            n = min(CHUNK, total - start)
            idx = start + np.arange(n)
            t = idx / sr
            mix = np.zeros((n, 2))
            if bgen:
                bmix = bgen.render(t)
                if gate_k is not None:      # same pulse envelope as the iso tone
                    env, _ = pulse_envelope(t, beats[gate_k], args.iso_duty, rin, rout)
                    bmix *= env[:, None]
                mix += b_amp * bmix
            if use_iso:
                mix += i_amp * render_isochronic(
                    t, tones, beats, args.iso_duty, rin, rout,
                    args.iso_mode == "stereo")
            mix *= scale * fade_gain(idx, total, fin, fout)[:, None]
            sink.write(to_pcm(mix, bits, rng))
            if not args.quiet:
                pct = 100.0 * (start + n) / total
                print(f"\rrendering   : {pct:5.1f}%", end="", file=sys.stderr)
        sink.close()
    except Cancelled:
        sink.abort()
        try:
            os.remove(out_path)
        except OSError:
            pass
        return False
    except RuntimeError as e:
        sink.abort()
        sys.exit(f"\n{e}")
    except BaseException:
        sink.abort()
        raise

    if not args.quiet:
        size = os.path.getsize(out_path) / 1e6
        print(f"\ndone. {size:.1f} MB", file=sys.stderr)
    return True


if __name__ == "__main__":
    main()
