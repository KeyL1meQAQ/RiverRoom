import { useEffect, useRef, useState } from "react";
import type { Hand, Room } from "./types";

let audio: AudioContext | undefined;
type SoundKind = 'chips' | 'check' | 'turn';
const buffers: Partial<Record<SoundKind, AudioBuffer>> = {};
let loading: Promise<void> | undefined;

function loadSounds() {
  if (!audio || loading) return;
  const context = audio;
  const turn = context.createBuffer(1, Math.round(context.sampleRate * .42), context.sampleRate);
  const samples = turn.getChannelData(0);
  for (let i = 0; i < samples.length; i++) {
    const t = i / context.sampleRate;
    const start = t < .21 ? 0 : .21;
    const local = t - start;
    if (local >= .17) continue;
    const frequency = start === 0 ? 660 : 880;
    const envelope = Math.min(1, local / .008) * Math.exp(-local * 19);
    samples[i] = .32 * envelope * (Math.sin(2 * Math.PI * frequency * local)
      + .15 * Math.sin(4 * Math.PI * frequency * local));
  }
  buffers.turn = turn;
  loading = Promise.all((['chips', 'check'] as const).map(async kind => {
    try {
      const response = await fetch(`/audio/${kind}.wav`);
      if (!response.ok) return;
      buffers[kind] = await context.decodeAudioData(await response.arrayBuffer());
    } catch { /* A missing sound must not interrupt the table. */ }
  })).then(() => {});
}

function unlockAudio() {
  try {
    audio ??= new AudioContext();
    loadSounds();
    if (audio.state === "suspended") void audio.resume().catch(() => {});
  } catch { /* Audio is optional on browsers without Web Audio support. */ }
}

type PlayingSound = { kind: SoundKind; turn: string | null; end: number; stop: () => void };

/** Schedule only already-loaded sounds; never replay an event after a late load/unlock. */
function playSound(kind: SoundKind, at: number, turn: string | null): PlayingSound | undefined {
  if (!audio || audio.state !== 'running' || !buffers[kind]) return;
  try {
    const source = audio.createBufferSource();
    source.buffer = buffers[kind]!;
    source.connect(audio.destination);
    source.onended = () => source.disconnect();
    source.start(at);
    return { kind, turn, end: at + source.buffer.duration,
      stop: () => { try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); } };
  } catch { return; }
}

export function useActionSounds(room: Room | null, now: number, connection: number,
  connected: boolean, muted: boolean) {
  const baseline = useRef('');
  const seen = useRef(new Set<string>());
  const reminded = useRef('');
  const playing = useRef<PlayingSound[]>([]);

  const stop = (predicate: (sound: PlayingSound) => boolean) => {
    playing.current = playing.current.filter(sound => {
      if (predicate(sound)) { sound.stop(); return false; }
      return !audio || sound.end > audio.currentTime;
    });
  };

  // Visibility changes can occur without receiving a new room snapshot.
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState !== 'visible') stop(sound => sound.kind !== 'turn');
    };
    const context = audio;
    const suspended = () => {
      if (context?.state !== 'running') stop(() => true);
    };
    document.addEventListener('visibilitychange', visibility);
    context?.addEventListener('statechange', suspended);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      context?.removeEventListener('statechange', suspended);
      stop(() => true);
    };
  }, []);

  useEffect(() => {
    const hand = room?.hand;
    // Wait for the first fresh WS state, not the preceding HTTP/offline snapshot.
    if (!room || !connected || !connection) { stop(() => true); return; }
    const connectionKey = `${room.id}:${room.me}:${connection}`;
    const freshConnection = baseline.current !== connectionKey;
    if (freshConnection) {
      baseline.current = connectionKey;
      seen.current.clear();
      reminded.current = '';
      stop(() => true);
    }
    const turn = hand && room.phase === 'betting' && !room.recovery && !room.closed_at
      && room.legal && hand.clock?.pid === room.me && hand.clock.until > now
      ? `${room.id}:${room.me}:${hand.number}:${hand.seq}` : '';
    stop(sound => muted || (sound.kind === 'turn' && sound.turn !== turn));
    const events = hand?.action_events ?? [];
    for (const event of events) {
      const key = `${hand!.number}:${event.seq}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      if (freshConnection || muted || room.recovery || room.closed_at
        || document.visibilityState !== 'visible' || now - event.at > 2 || event.at > now + .1) continue;
      if (!audio || audio.state !== 'running') continue;
      const end = Math.max(audio.currentTime, ...playing.current.map(sound => sound.end + .035));
      // Bound the queue: rapid snapshots must never create a long audio backlog.
      if (end - audio.currentTime > .8) continue;
      const sound = playSound(event.kind, end, null);
      if (sound) playing.current.push(sound);
    }
    if (seen.current.size > 128) {
      seen.current = new Set(events.map(event => `${hand!.number}:${event.seq}`));
    }
    if (turn && reminded.current !== turn) {
      reminded.current = turn;
      if (!muted && audio?.state === 'running') {
        const end = Math.max(audio.currentTime, ...playing.current.map(sound => sound.end + .035));
        // Do not start a queued reminder after the action has already expired.
        if (end - audio.currentTime < hand!.clock!.until - now) {
          const sound = playSound('turn', end, turn);
          if (sound) playing.current.push(sound);
        }
      }
    }
  }, [room, now, connection, connected, muted]);
}

function dealSound() {
  if (!audio || audio.state !== "running" || document.visibilityState !== "visible") return;
  const duration = .085;
  const buffer = audio.createBuffer(1, Math.floor(audio.sampleRate * duration), audio.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  const source = audio.createBufferSource();
  const filter = audio.createBiquadFilter();
  const gain = audio.createGain();
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.value = 2300;
  filter.Q.value = .7;
  gain.gain.setValueAtTime(.001, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(.16, audio.currentTime + .006);
  gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + duration);
  source.connect(filter).connect(gain).connect(audio.destination);
  source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  source.start();
}

export function useSoundPreference() {
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("river_muted") === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { audio ??= new AudioContext(); loadSounds(); } catch { /* Audio is optional. */ }
    document.addEventListener("pointerdown", unlockAudio);
    document.addEventListener("keydown", unlockAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockAudio);
      document.removeEventListener("keydown", unlockAudio);
    };
  }, []);
  const toggle = () => setMuted(value => {
    try { localStorage.setItem("river_muted", String(!value)); } catch { /* Keep session preference. */ }
    return !value;
  });
  return { muted, toggle };
}

export function useBoardPresentation(hand: Hand | null, now: number, connection: number, sound: boolean) {
  const baseline = useRef({ connection, at: now });
  const sounded = useRef(new Set<string>());
  if (baseline.current.connection !== connection) baseline.current = { connection, at: now };
  const deal = hand?.deal;
  let step = 0;
  const events: { key: string; at: number }[] = [];
  const animated = new Set<string>();
  const boards = (hand?.boards?.length ? hand.boards : [[]]).map((board, b) => {
    const previous = deal?.previous[b] ?? board.length;
    return board.filter((card, c) => {
      if (!deal || c < previous) return true;
      const at = deal.start + step++ * .25;
      const key = `${hand!.number}:${b}:${c}:${card}`;
      if (now < at) return false;
      events.push({ key, at });
      if (at > baseline.current.at && now - at < .24) animated.add(`${b}:${c}`);
      return true;
    });
  });
  useEffect(() => { sounded.current.clear(); }, [hand?.number]);
  useEffect(() => {
    for (const { key, at } of events) {
      if (sounded.current.has(key)) continue;
      sounded.current.add(key);
      if (sound && at > baseline.current.at && now - at < .3) dealSound();
    }
  });
  return { boards, animated };
}
