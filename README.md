# Lenti Studio

Turn photos from multi-lens film cameras (Nimslo, Nishika, Reto3D and friends) into looping
wigglegram videos — right on your machine.

This is the standalone studio behind [lentistudio.com](https://lentistudio.com), without the
gallery, accounts or hosting infrastructure. One container, no sign-up, your frames never leave
your computer.

## Run

You only need [Docker](https://docs.docker.com/get-docker/).

```sh
git clone https://github.com/buuushe/lentistudio.git
cd lentistudio
make
```

Open <http://localhost:8080>. The first build takes a few minutes.

| Command      | What it does                                       |
| ------------ | -------------------------------------------------- |
| `make`       | Build and start the studio                         |
| `make down`  | Stop it                                            |
| `make logs`  | Follow the logs                                    |
| `make clean` | Stop it and delete uploaded frames and renders     |
| `make test`  | Run the server and web checks inside Docker        |

Another port: `make PORT=9000`.

## What it does

- **Frames or whole scans.** Drop single frames, or scans holding two, three or four frames side
  by side — the studio cuts them for you.
- **Sets of 2–5 photos.** Pick the number of lenses of your camera; the library is split into sets
  and the order inside each set is detected automatically.
- **Focus point alignment.** Mark a point on one frame and the studio finds it on the others, so
  the subject stays still while the background wiggles.
- **Tone balance.** Brightness, contrast and sharpening per frame or per set, with automatic
  balancing of uneven exposures.
- **Loops and compositions.** Ping-pong, forward, ends, middle or a custom pattern per set;
  several sets in one video with crossfades, double exposure, split frame, mosaic or triptych.
- **Output.** Crop presets for Instagram or a free frame, one MP4 for everything or one per set in
  a zip.

Uploaded frames and renders live in a Docker volume and are removed after 24 hours of inactivity
(`SESSION_TTL_HOURS`).

## Settings

Set these as environment variables before `make` (see `docker-compose.yml`):

| Variable             | Default     | Meaning                                  |
| -------------------- | ----------- | ---------------------------------------- |
| `PORT`               | `8080`      | Port on localhost                        |
| `MEMORY`             | `2g`        | Memory limit of the container            |
| `CPUS`               | `2`         | CPU limit of the container               |
| `MAX_UPLOAD_MB`      | `25`        | Largest accepted file                    |
| `MAX_IMAGE_SIDE`     | `3000`      | Frames are downscaled to this long side  |
| `MAX_LIBRARY`        | `200`       | Frames per session                       |
| `MAX_RENDER_PIXELS`  | `160000000` | Pixel budget of one render               |
| `SESSION_TTL_HOURS`  | `24`        | Idle sessions are deleted after this     |
| `RENDER_CONCURRENCY` | `2`         | Renders running at the same time         |

## Layout

```
server/   FastAPI + OpenCV + ffmpeg: uploads, scan cutting, point matching, rendering
web/      Vue 3 + Pinia + Tailwind: the studio UI
```

The web app is built into the same image and served by the server.

## License

[MIT](LICENSE)
