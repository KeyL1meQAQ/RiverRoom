import { useEffect, useRef, useState } from "react";
import type { Hand } from "./types";

let audio: AudioContext | undefined;

function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume().catch(() => {});
  } catch { /* Audio is optional on browsers without Web Audio support. */ }
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
