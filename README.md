# Isobin — browser audio generator

Isobin is a static Astro website that recreates the Isobin desktop generator in the browser. Visitors configure a session, render the audio on their own device, and download the resulting file. No application backend is required and the audio is not uploaded.

## Features

- Stereo binaural tones with ordered left/right frequency sections, continuous phase, looping sections, smooth glides, and optional synchronization to an isochronic pulse.
- Isochronic tones with multiple simultaneous carriers, independent pulse rates, duty cycle, pulse fades, and mono or alternating left/right pulses.
- Combined binaural + isochronic sessions, master fades, volume controls, peak-aware gain staging, and presets matching the Python GUI (Alpha, Theta, Delta, Beta, synchronized 10 Hz, and descending 90-minute session).
- Native browser-side WAV generation in a Web Worker (16-bit with TPDF dither or 24-bit PCM).
- MP3, FLAC, and Opus encoding through FFmpeg WebAssembly, loaded only when an encoded format is selected.
- Session settings saved locally in the browser, output-size estimate, render progress, cancellation, and an equivalent Python CLI command.

## Requirements

- Node.js `22.23.4` or newer (the current Astro 7 release requires this minimum).
- npm.

## Run locally

```sh
npm install
npm run dev
```

Open the local URL printed by Astro.

## Build

```sh
npm run build
npm run preview
```

## GitHub Pages

The site is configured for `https://ayr-farias.github.io/isobin/` using Astro's `site` and `base` settings in `astro.config.mjs`. The workflow in `.github/workflows/deploy.yml` builds and publishes the static site whenever a commit reaches `main` (or when manually triggered).

In the repository settings, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. The workflow then publishes the site automatically.

## Audio rendering notes

- WAV is generated directly in the browser and does not require an encoder download.
- MP3, FLAC, and Opus load the single-threaded FFmpeg WebAssembly core on first use. The core is approximately 31 MB and is fetched from jsDelivr; later encoded sessions reuse it while the page remains open.
- Audio synthesis takes place in a Web Worker. FFmpeg runs in its own worker. Audio samples remain on the visitor's device; the app does not send audio to an application server.
- Long, high-sample-rate sessions can create large files and need substantial RAM. The interface estimates output size and asks for confirmation for large renders. There is a 1.5 GB render safety ceiling, and browser-side transcoding is restricted to WAV source data below 950 MiB.
- Browser support for playing FLAC and Opus varies, but the generated files can be downloaded and opened in a compatible desktop player.

## Python versions

The original `isobin.py` and `isobin_gui.py` files are preserved in the repository. They remain usable as the command-line and desktop versions (Python, NumPy, Tkinter, and FFmpeg requirements are documented in the script headers). The website does not execute Python on GitHub Pages.

The browser synthesizer follows the signal model in `isobin.py`: phase-continuous binaural carriers, section cycles and smooth glides, raised-cosine pulse gates, alternating stereo pulses, file fades, 16-bit TPDF dither, and gain staging. The UI and presets follow `isobin_gui.py`.

## Third-party encoder

The browser-side encoder uses [`@ffmpeg/ffmpeg`](https://github.com/ffmpegwasm/ffmpeg.wasm) and the FFmpeg WebAssembly core. The core is fetched on demand from jsDelivr; its FFmpeg and bundled-library licenses apply to that component. See the FFmpeg.wasm project for license and build details.
