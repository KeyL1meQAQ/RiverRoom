import React, { useState } from "react";
import type { Player, Room } from "./types";
import "./interactions.css";

export const EMOJI = ["😏", "😂", "🙃", "👀", "👏", "😭", "😎", "🤔", "😅", "🤝", "😱", "🫡"];
export const PHRASES = ["我很抱歉", "打得不错", "漂亮！", "这也敢跟？", "让我想想", "运气真好",
  "稳住", "有点意思", "别着急", "手下留情", "你来试试", "下一手见"];
export const ITEMS = [
  { id: "tomato", label: "番茄", symbol: "🍅" },
  { id: "egg", label: "鸡蛋", symbol: "🥚" },
  { id: "poop", label: "大便", symbol: "💩" },
] as const;

export type InteractionEvent = (
  | { kind: "bubble"; preset: string }
  | { kind: "throw"; target: string; item: typeof ITEMS[number]["id"]; count: 1 | 10 }
) & { id: string; at: number; from: string };

export function BubblePicker({ send, close, disabled }: {
  send: (preset: string) => void;
  close: () => void;
  disabled: boolean;
}) {
  const [tab, setTab] = useState<"emoji" | "phrase">("emoji");
  return <div className="interaction-picker" role="dialog" aria-label="发送气泡">
    <div className="interaction-picker-head">
      <div className="interaction-tabs" role="tablist" aria-label="气泡类型">
        <button type="button" role="tab" aria-selected={tab === "emoji"} onClick={() => setTab("emoji")}>表情</button>
        <button type="button" role="tab" aria-selected={tab === "phrase"} onClick={() => setTab("phrase")}>短句</button>
      </div>
      <button type="button" className="interaction-picker-close" onClick={close} aria-label="关闭气泡菜单">×</button>
    </div>
    <div className={tab === "emoji" ? "interaction-emoji-grid" : "interaction-phrase-grid"}>
      {(tab === "emoji" ? EMOJI : PHRASES).map(preset => <button type="button" key={preset}
        aria-label={`发送 ${preset}`} disabled={disabled} onClick={() => send(preset)}>{preset}</button>)}
    </div>
  </div>;
}

export function ThrowPicker({ target, send, singleDisabled, burstDisabled }: {
  target: Player;
  send: (item: typeof ITEMS[number]["id"], count: 1 | 10) => void;
  singleDisabled: boolean;
  burstDisabled: boolean;
}) {
  return <div className="throw-picker" role="group" aria-label={`向 ${target.name} 投掷道具`}>
    <h3>投掷道具</h3>
    {ITEMS.map(item => <div className="throw-option" key={item.id}>
      <span className="throw-option-symbol" aria-hidden="true">{item.symbol}</span>
      <span className="throw-option-label">{item.label}</span>
      <button type="button" disabled={singleDisabled} onClick={() => send(item.id, 1)}
        aria-label={`向 ${target.name} 扔一个${item.label}`}>扔 1 个</button>
      <button type="button" disabled={burstDisabled} onClick={() => send(item.id, 10)}
        aria-label={`向 ${target.name} 十连投掷${item.label}`}>×10</button>
    </div>)}
  </div>;
}

function positionFor(room: Room, ownSeat: number, pid: string, positions: number[][]) {
  const seat = room.players.find(player => player.id === pid)?.seat;
  return seat == null ? null : positions[(seat - ownSeat + 9) % 9];
}

export function InteractionLayer({ room, ownSeat, events, desktop, mobile }: {
  room: Room;
  ownSeat: number;
  events: InteractionEvent[];
  desktop: number[][];
  mobile: number[][];
}) {
  return <>
    {events.filter(event => event.kind === "bubble").map(event => {
      const player = room.players.find(p => p.id === event.from);
      if (player?.seat == null) return null;
      const position = (player.seat - ownSeat + 9) % 9;
      return <div className={`table-bubble position-${position} ${EMOJI.includes(event.preset) ? "emoji" : ""} ${position >= 3 && position <= 6 ? "below" : ""}`}
        key={event.id} role="status" style={{
          "--bubble-x": `${desktop[position][0]}%`, "--bubble-y": `${desktop[position][1]}%`,
          "--bubble-mobile-x": `${mobile[position][0]}%`, "--bubble-mobile-y": `${mobile[position][1]}%`,
        } as React.CSSProperties}>{event.preset}</div>;
    })}
    {events.filter(event => event.kind === "throw").flatMap(event => {
      if (event.kind !== "throw") return [];
      const from = positionFor(room, ownSeat, event.from, desktop);
      const to = positionFor(room, ownSeat, event.target, desktop);
      const mobileFrom = positionFor(room, ownSeat, event.from, mobile);
      const mobileTo = positionFor(room, ownSeat, event.target, mobile);
      if (!from || !to || !mobileFrom || !mobileTo) return [];
      const symbol = ITEMS.find(item => item.id === event.item)?.symbol;
      return Array.from({ length: event.count }, (_, index) => <span
        key={`${event.id}:${index}`} className="throw-flight" aria-hidden="true" style={{
          "--from-x": `${from[0]}%`, "--from-y": `${from[1]}%`,
          "--to-x": `${to[0]}%`, "--to-y": `${to[1]}%`,
          "--mobile-from-x": `${mobileFrom[0]}%`, "--mobile-from-y": `${mobileFrom[1]}%`,
          "--mobile-to-x": `${mobileTo[0]}%`, "--mobile-to-y": `${mobileTo[1]}%`,
          animationDelay: `${index * .43}s`,
        } as React.CSSProperties}>{symbol}</span>);
    })}
  </>;
}
