import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clipboard,
  Coins,
  Copy,
  Crown,
  Eye,
  History,
  KeyRound,
  Link,
  LogOut,
  Menu,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings,
  ShieldCheck,
  Spade,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type { Config, Hand, Player, PotResult, Room } from "./types";
import { useBoardPresentation, useSoundPreference } from "./presentation";
import "./styles.css";

const defaults: Config = {
  sb: 1,
  bb: 2,
  timebank: 10,
  refill: 20,
  straddle: false,
  twice: false,
};
const n = (v: number) =>
  v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
const signed = (v: number) => `${v > 0 ? "+" : ""}${n(v)}`;
// Keep every digit readable when a narrow seat needs more than one amount line.
function seatAmount(value: number) {
  const parts = n(value).split(",");
  return parts.map((part, index) =>
    <React.Fragment key={index}>{index > 0 && <wbr />}{part}{index < parts.length - 1 ? "," : ""}</React.Fragment>,
  );
}
const commandId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const phases: Record<string, string> = {
  waiting: "等待开局",
  straddle: "UTG 选择中",
  betting: "牌局进行中",
  dealing: "正在发公共牌",
  runout: "选择发牌次数",
  between: "本手已结算",
  rebuy: "等待重买入",
  closed: "房间已结束",
};
async function api(path: string, body?: unknown) {
  const response = await fetch(
    path,
    body === undefined
      ? { credentials: "same-origin" }
      : {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string" ? data.detail : "请求失败，请稍后重试",
    );
  return data;
}

function IconButton({
  title,
  children,
  onClick,
  disabled,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      aria-label={title}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

const ToastHostContext = createContext<
  React.Dispatch<React.SetStateAction<HTMLDialogElement | null>>
>(() => {});

function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const setToastHost = useContext(ToastHostContext);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    setToastHost(dialog);
    return () => {
      setToastHost((current) => current === dialog ? null : current);
    };
  }, [setToastHost]);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <IconButton title="关闭" onClick={close}>
          <X size={19} />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}

function CopyField({
  label,
  value,
  copyValue = value,
  buttonLabel = `复制${label}`,
  notify,
}: {
  label: string;
  value: string;
  copyValue?: string;
  buttonLabel?: string;
  notify: (message: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const copy = async () => {
    const input = ref.current;
    if (!input) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyValue);
        if (input.isConnected) notify("已复制");
        return;
      }
    } catch {
      // Permission denial can still allow the user-initiated legacy copy.
    }
    if (!input.isConnected) return;

    const previousFocus = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.value = copyValue;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.style.cssText = "position:fixed;left:-9999px;top:0;font-size:16px;";
    // Modal dialogs make nodes outside them inert, including copy fallbacks.
    (input.closest("dialog") || document.body).append(textarea);
    let copied = false;
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, copyValue.length);
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      textarea.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    }
    if (!copied) {
      input.focus({ preventScroll: true });
      input.select();
      input.setSelectionRange(0, input.value.length);
    }
    notify(copied ? "已复制" : "请长按或手动复制");
  };
  return (
    <div className="copy-field">
      <input ref={ref} aria-label={label} readOnly value={value} />
      <IconButton title={buttonLabel} onClick={copy}>
        <Copy size={19} />
      </IconButton>
    </div>
  );
}

function ConfigFields({
  value,
  change,
}: {
  value: Config;
  change: (v: Config) => void;
}) {
  const field = (
    key: keyof Config,
    label: string,
    min: number,
    max?: number,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step="1"
        required
        value={Number(value[key])}
        onChange={(e) => change({ ...value, [key]: Number(e.target.value) })}
      />
    </label>
  );
  return (
    <div className="config-fields">
      <div className="form-grid">
        {field("sb", "小盲", 1)}
        {field("bb", "大盲", value.sb)}
      </div>
      <div className="form-grid">
        {field("timebank", "TimeBank / 秒", 0, 600)}
        {field("refill", "补满间隔 / 手", 1, 10000)}
      </div>
      <label className="switch-row">
        <span>允许发两次牌</span>
        <input
          type="checkbox"
          role="switch"
          checked={value.twice}
          onChange={(e) => change({ ...value, twice: e.target.checked })}
        />
      </label>
      <label className="switch-row">
        <span>允许 UTG Straddle</span>
        <input
          type="checkbox"
          role="switch"
          checked={value.straddle}
          onChange={(e) => change({ ...value, straddle: e.target.checked })}
        />
      </label>
    </div>
  );
}

function Card({
  code,
  back,
  small = false,
  winning = false,
  animate = false,
}: {
  code?: string | null;
  back?: boolean;
  small?: boolean;
  winning?: boolean;
  animate?: boolean;
}) {
  const suits: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
  const rank = code?.[0] === "T" ? "10" : code?.[0];
  const suit = code?.[1] || "s";
  return (
    <span
      className={`playing-card ${small ? "small" : ""} ${back ? "back" : ""} ${!code && !back ? "placeholder" : ""} ${suit === "h" || suit === "d" ? "red" : ""} ${winning ? "winning-card" : ""} ${animate ? "card-dealt" : ""}`}
      data-winning={winning || undefined}
      aria-label={back ? "未公开底牌" : code || "未发公共牌"}
    >
      {back ? (
        <img src="/card-back.svg" alt="" />
      ) : code ? (
        <>
          <b>{rank}</b>
          <span>{suits[suit]}</span>
        </>
      ) : null}
    </span>
  );
}

function Lobby({
  enter,
  error,
}: {
  enter: (rid: string) => void;
  error: (message: string) => void;
}) {
  const [name, setName] = useState("好友牌桌");
  const [config, setConfig] = useState(defaults);
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [lobbyTab, setLobbyTab] = useState<"create" | "join">("create");
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await api("/api/rooms", { name, settings: config });
      enter(result.id);
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const value = invite.trim();
    const rid = value.includes("/")
      ? value.split("/r/")[1]?.split(/[?#/]/)[0]
      : value;
    if (!rid || !/^[\w-]{8,40}$/.test(rid)) {
      error("请输入有效的房间链接或房间编码");
      return;
    }
    enter(rid);
  };
  return (
    <div className="lobby">
      <header className="site-header">
        <div className="brand">
          <Spade fill="currentColor" size={24} />
          <span>RIVER ROOM</span>
        </div>
        <span className="header-caption">德州扑克 · 无限注常规桌</span>
      </header>
      <main className="lobby-main">
        <div className="lobby-title">
          <div>
            <div className="eyebrow">PRIVATE POKER TABLE</div>
            <h1>River Room</h1>
            <p>开一桌，等朋友。</p>
          </div>
          <div className="lobby-cards" aria-hidden="true">
            <Card code="As" />
            <Card code="Kh" />
            <span className="chip red-chip">100</span>
          </div>
        </div>
        <div
          className="lobby-tabs mobile-only"
          role="tablist"
          aria-label="牌桌入口"
        >
          <button
            role="tab"
            aria-selected={lobbyTab === "create"}
            onClick={() => setLobbyTab("create")}
          >
            创建牌桌
          </button>
          <button
            role="tab"
            aria-selected={lobbyTab === "join"}
            onClick={() => setLobbyTab("join")}
          >
            加入牌桌
          </button>
        </div>
        <div className={`lobby-columns lobby-${lobbyTab}`}>
          <section className="create-section">
            <div className="section-title">
              <h2>创建牌桌</h2>
              <span>
                <Users size={15} /> 2–9 人
              </span>
            </div>
            <form onSubmit={create}>
              <label>
                房间名称
                <input
                  value={name}
                  maxLength={20}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <ConfigFields value={config} change={setConfig} />
              <button className="primary wide" disabled={busy}>
                <Plus size={18} />
                {busy ? "创建中…" : "创建房间"}
              </button>
            </form>
          </section>
          <section className="join-section">
            <div className="section-title">
              <h2>加入牌桌</h2>
              <Link size={19} />
            </div>
            <form onSubmit={join}>
              <label>
                房间链接或编码
                <input
                  autoComplete="off"
                  placeholder="粘贴邀请链接"
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  required
                />
              </label>
              <button className="secondary wide">
                进入房间
                <ArrowRight size={18} />
              </button>
            </form>
            <div className="lobby-table-art" aria-hidden="true">
              <div className="mini-felt">
                <Spade size={32} />
                <span>RIVER ROOM</span>
                <div className="mini-board">
                  {["7h", "Tc", "Js"].map((c) => (
                    <Card key={c} code={c} small />
                  ))}
                </div>
              </div>
              <i className="mini-seat one" />
              <i className="mini-seat two" />
              <i className="mini-seat three" />
              <span className="chip dark-chip">25</span>
            </div>
          </section>
        </div>
        <footer className="lobby-footer">
          <span>
            <ShieldCheck size={15} />
            私人牌桌 · 筹码记账
          </span>
          <span>NO LIMIT HOLD’EM</span>
        </footer>
      </main>
    </div>
  );
}

const desktopPositions = [
  [50, 88],
  [20, 81],
  [11, 51],
  [16, 25],
  [36, 9],
  [64, 9],
  [84, 25],
  [89, 51],
  [80, 81],
];
const mobilePositions = [
  [50, 94],
  [13, 82],
  [13, 62],
  [13, 33],
  [34, 13],
  [66, 13],
  [87, 33],
  [87, 62],
  [87, 82],
];

function potTitle(group: PotResult, hand: Hand) {
  return `${hand.boards.length > 1 ? `第 ${group.board + 1} 次 · ` : ""}${group.pot ? `边池 ${group.pot}` : "主池"}${group.winners.length > 1 ? " · 平分" : ""}`;
}

function WinningHands({ group, hand }: { group: PotResult; hand: Hand }) {
  return <div className="winning-hands">
    {group.winners.map(winner => <div className="winning-hand" key={winner.pid}>
      <div className="winning-hand-heading">
        <span className="winning-name" title={hand.result?.find(p => p.pid === winner.pid)?.name}>
          {hand.result?.find(p => p.pid === winner.pid)?.name}
        </span>
        <strong>{winner.label}</strong>
        <span>+{n(winner.amount)}</span>
      </div>
      <div className="winning-five" aria-label={`${winner.label}的五张牌`}>
        {winner.cards.map(card => <Card key={card} code={card} small />)}
      </div>
    </div>)}
  </div>;
}

function PokerTable({
  room,
  now,
  sit,
  select,
  reveal,
  revealing,
  connection,
  sound,
}: {
  room: Room;
  now: number;
  sit: (seat: number) => void;
  select: (p: Player) => void;
  reveal: (indices: number[]) => void;
  revealing: boolean;
  connection: number;
  sound: boolean;
}) {
  const me = room.players.find((p) => p.id === room.me)!;
  const hand = room.hand;
  const showingResult = !!(hand?.result && now < hand.reveal_until);
  const { boards, animated } = useBoardPresentation(hand, now, connection, sound);
  const groups = showingResult ? hand?.showdown_results || [] : [];
  const mainGroups = groups.filter(group => group.pot === 0);
  const ownSeat = (showingResult ? hand!.seats[hand!.ids.indexOf(me.id)] : undefined) ?? me.seat ?? 0;
  const playing = hand && hand.result === null;
  const countdown = Math.max(0, Math.ceil((room.deadline || 0) - now));
  return (
    <div className={`table-stage ${showingResult ? "showing-result" : ""} ${boards.length > 1 ? "double-board" : ""}`}>
      <div className="table-rail">
        <div className="felt">
          <span className="felt-brand">
            <Spade fill="currentColor" size={19} /> RIVER ROOM
          </span>
        </div>
      </div>
      <div className="table-center">
        {room.number > 0 && (
          <div className="pot-label">
            {hand?.result ? "本手底池" : "底池"}{" "}
            <strong>
              {n(
                hand?.result
                  ? hand.awards.reduce(
                      (s, a) => s + a.amounts.reduce((s, a) => s + a, 0),
                      0,
                    )
                  : room.pot,
              )}
            </strong>
          </div>
        )}
        <div className="boards">
          {boards.map((board, i) => (
            <div className="board" key={i}>
              {hand && hand.boards.length > 1 && (
                <span className="board-number">{i + 1}</span>
              )}
              {Array.from({ length: 5 }, (_, j) => (
                <Card key={`${j}:${board[j] || "empty"}`} code={board[j]}
                  animate={animated.has(`${i}:${j}`)}
                  winning={mainGroups.some(group => group.board === i && group.winners.some(w => w.cards.includes(board[j])))} />
              ))}
            </div>
          ))}
        </div>
        {room.pots.length > 1 && playing && (
          <div className="side-pots">
            {room.pots.map((v, i) => (
              <span key={i}>
                {i ? `边池 ${i}` : "主池"} {n(v)}
              </span>
            ))}
          </div>
        )}
        <div className="table-status">
          {room.recovery
            ? "等待房主恢复游戏"
            : room.closed_at
              ? "房间已结束"
              : room.phase === "straddle"
                ? `UTG 选择 Straddle · ${countdown}s`
                : room.phase === "runout"
                  ? `发两次牌？ · ${countdown}s`
                  : room.phase === "rebuy"
                    ? `等待重买入 · ${countdown}s`
                    : room.paused
                      ? "本手结束后暂停"
                      : room.phase === "waiting"
                        ? room.started
                          ? "等待玩家入座"
                          : "等待房主开局"
                        : room.phase === "dealing"
                          ? "正在发公共牌"
                        : room.phase === "between"
                          ? `下一手 · ${countdown}s`
                          : "无限注德州扑克"}
        </div>
      </div>
      {Array.from({ length: 9 }, (_, seat) => {
        const handPlayer = showingResult ? hand!.ids[hand!.seats.indexOf(seat)] : undefined;
        const p = handPlayer
          ? room.players.find((p) => p.id === handPlayer)
          : room.players.find((p) => p.seat === seat && !(showingResult && hand!.ids.includes(p.id)));
        const position = (seat - ownSeat + 9) % 9;
        const [x, y] = desktopPositions[position],
          [mx, my] = mobilePositions[position];
        const actor = p && hand?.clock?.pid === p.id && !room.recovery;
        const bankMode = actor && now >= hand!.clock!.base_until;
        const seconds = actor
          ? Math.max(
              0,
              Math.ceil(
                (bankMode ? hand!.clock!.until : hand!.clock!.base_until) - now,
              ),
            )
          : 0;
        const inHand = p && playing && hand.ids.includes(p.id);
        const allIn = p && inHand && !p.folded && p.stack === 0;
        const tableAction = p && inHand && !actor ? hand.last_actions[p.id] : undefined;
        const betAmount = p && inHand && tableAction !== '弃牌' ? p.bet : 0;
        const cards = inHand || (p && hand?.ids.includes(p.id)) ? p?.cards : [];
        const labels = p && showingResult ? hand?.public_hand_labels?.[p.id] : undefined;
        const ownLabels = p?.id === room.me && hand?.own_hand_labels?.length && (playing || showingResult)
          ? hand.own_hand_labels.map((values, board) => values[boards[board]?.length || 0])
          : [];
        const displayedLabels = labels?.length ? labels : ownLabels;
        const payout = p && showingResult ? hand?.result?.find(result => result.pid === p.id)?.won || 0 : 0;
        const mainWinner = p && showingResult && hand?.awards.some(award => award.pot === 0 &&
          (award.winners?.includes(hand.ids.indexOf(p.id)) || award.amounts[hand.ids.indexOf(p.id)] > 0));
        const winningHoles = new Set(mainGroups.flatMap(group => group.winners.filter(w => w.pid === p?.id).flatMap(w => w.cards)));
        const status = p && showingResult && p.seat === null
          ? "已离座"
          : p?.leave
          ? "本手后离座"
          : p?.away
            ? "AWAY"
            : p && !p.online
              ? "离线"
              : p?.folded && playing
                ? "已弃牌"
                : p && room.rebuy.includes(p.id)
                  ? "等待重买入"
                  : p?.id === room.me
                    ? "你"
                    : "";
        const compactStatus = status === "本手后离座"
          ? "离座中"
          : status === "等待重买入"
            ? "重买入"
            : status;
        return (
          <div
            key={seat}
            className={`seat-wrap position-${position} ${p?.id === room.me ? "own-seat" : ""} ${displayedLabels.length || payout ? "has-result" : ""} ${displayedLabels.length > 1 ? "double-result" : ""} ${p && (n(p.stack).length > 7 || n(payout).length > 6) ? "large-amounts" : ""}`}
            style={
              {
                "--x": `${x}%`,
                "--y": `${y}%`,
                "--mx": `${mx}%`,
                "--my": `${my}%`,
              } as React.CSSProperties
            }
          >
            {p ? (
              <button
                className={`seat occupied ${p.id === room.me ? "self" : ""} ${actor ? "acting" : ""} ${p.away || (p.folded && playing) ? "muted" : ""} ${mainWinner ? "winning-seat" : ""}`}
                onClick={() => select(p)}
                aria-label={`${p.name}，筹码 ${p.stack}`}
              >
                <div className="seat-top">
                  {p.id === room.owner && <Crown size={11} className="seat-owner" aria-label="房主" />}
                  <span className="seat-name" title={p.name}>
                    {p.name}
                  </span>
                  {!p.online && <WifiOff size={11} className="offline-icon" aria-label="离线" />}
                  {allIn ? <span className="seat-state all-in" title={status}>全下</span>
                    : compactStatus && compactStatus !== "你" && compactStatus !== "离线" && <span className="seat-state" title={status}>{compactStatus}</span>}
                </div>
                <div className="seat-stack-row">
                  <strong className={`stack ${n(p.stack).length > 5 ? "long-stack" : ""}`} title={n(p.stack)}>
                    <span className="stack-full">{seatAmount(p.stack)}</span>
                    <span
                      className="stack-mobile"
                      style={{ fontSize: n(p.stack).length > 3 ? 11 : undefined }}
                    >
                      {p.stack >= 100000
                        ? new Intl.NumberFormat("en", {
                            notation: "compact",
                            maximumFractionDigits: 1,
                          }).format(p.stack)
                        : n(p.stack)}
                    </span>
                  </strong>
                  {payout > 0 && <strong className="seat-payout"
                    style={{ '--amount-length': n(payout).length } as React.CSSProperties}
                    aria-label={`获胜 ${n(payout)}`}>+{seatAmount(payout)}</strong>}
                </div>
                {displayedLabels.length > 0 && <div
                  className={`seat-hand-label ${p.id === room.me ? "own-hand-label" : "public-hand-label"}`}
                  aria-label={p.id === room.me ? "本人成牌" : `${p.name}的摊牌牌型`}>
                  {displayedLabels.map((label, board) => {
                    const boardWinner = mainGroups.some(group => group.board === board && group.winners.some(w => w.pid === p.id));
                    return <span className={boardWinner ? "won-main" : ""} key={board} data-board={board}
                      title={`${displayedLabels.length > 1 ? `第 ${board + 1} 次：` : ""}${label}`}>
                      {displayedLabels.length > 1 && <small>{board === 0 ? "①" : "②"}</small>}{label}
                    </span>;
                  })}
                </div>}
                {actor && (
                  <div className="turn-track" role="progressbar" aria-label={bankMode ? "额外思考时间" : "行动剩余时间"}
                    aria-valuemin={0} aria-valuemax={bankMode ? Math.max(1, hand!.clock!.initial) : 20} aria-valuenow={seconds}>
                    <div className={`turn-progress ${bankMode ? "bank" : ""}`}
                      style={{ width: `${Math.min(100, Math.max(0, (seconds / (bankMode ? Math.max(1, hand!.clock!.initial) : 20)) * 100))}%` }} />
                  </div>
                )}
              </button>
            ) : (
              <button
                className="seat empty"
                onClick={() => sit(seat)}
                disabled={
                  me.seat !== null ||
                  !!room.closed_at ||
                  room.closing ||
                  me.banned
                }
                aria-label={`入座 ${seat + 1} 号位`}
              >
                <Plus size={21} />
                <span>空位 {seat + 1}</span>
              </button>
            )}
            {p && room.button === seat && (
              <span className="dealer" title="按钮位">
                D
              </span>
            )}
            {p && (betAmount > 0 || tableAction) && (
              <div className={`seat-bet ${betAmount > 0 ? 'with-amount' : 'action-only'} ${tableAction === '弃牌' ? 'fold-action' : ''} ${n(betAmount).length > 5 ? 'large-bet' : ''}`}
                aria-label={`${p.name} ${tableAction || '下注'}${betAmount > 0 ? ` ${n(betAmount)}` : ''}`}
                title={betAmount > 0 ? `${tableAction || '下注'} ${n(betAmount)}` : tableAction}>
                {betAmount > 0 ? <span className="bet-chip" aria-hidden="true" />
                  : tableAction && <span className="bet-action">{tableAction}</span>}
                {betAmount > 0 && <strong className="bet-amount"
                  style={{ '--amount-length': n(betAmount).length } as React.CSSProperties}>
                  {seatAmount(betAmount)}
                </strong>}
              </div>
            )}
            {p && (
              <div
                className={`hole-cards ${p.folded && playing ? "folded" : ""}`}
                role={!room.started ? "img" : undefined}
                aria-label={!room.started ? "底牌区域，尚未发牌" : undefined}
              >
                {cards?.length ? (
                  cards.map((c, i) =>
                    p.id === room.me && hand?.result && now < hand.reveal_until ? (
                      <button
                        key={i}
                        className="reveal-card"
                        title={hand.shown_cards[p.id]?.includes(i) ? "已公开" : `亮出 ${c}`}
                        aria-label={hand.shown_cards[p.id]?.includes(i) ? `${c} 已公开` : `亮出 ${c}`}
                        disabled={revealing || hand.shown_cards[p.id]?.includes(i)}
                        onClick={() => reveal([i])}
                      >
                        <Card code={c} small winning={!!c && winningHoles.has(c)} />
                      </button>
                    ) : <Card key={i} code={c} back={c === null} small
                      winning={!!c && winningHoles.has(c)} />,
                  )
                ) : inHand && !p.folded ? (
                  <>
                    <Card back small />
                    <Card back small />
                  </>
                ) : !room.started ? (
                  <>
                    <span className="playing-card small hole-card-outline" aria-hidden="true">
                      <Spade className="hole-card-mark" fill="currentColor" />
                    </span>
                    <span className="playing-card small hole-card-outline" aria-hidden="true">
                      <Spade className="hole-card-mark" fill="currentColor" />
                    </span>
                  </>
                ) : null}
              </div>
            )}
            {p?.folded && playing && !cards?.length && (
              <span className="folded-cards" aria-hidden="true"><X size={42} /></span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RoomScreen({
  rid,
  home,
  error,
}: {
  rid: string;
  home: () => void;
  error: (msg: string) => void;
}) {
  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState<
    "connecting" | "connected" | "offline" | "revoked"
  >("connecting");
  const [failure, setFailure] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [connection, setConnection] = useState(0);
  const sound = useSoundPreference();
  const [now, setNow] = useState(Date.now() / 1000);
  const offset = useRef(0);
  const [modal, setModal] = useState<string | null>(null);
  const [seat, setSeat] = useState(0);
  const [nickname, setNickname] = useState("");
  const [amount, setAmount] = useState(200);
  const [raise, setRaise] = useState(4);
  const [code, setCode] = useState("");
  const [config, setConfig] = useState(defaults);
  const [targetSnapshot, setTarget] = useState<Player | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<"log" | "stats" | "history" | "manage">(
    "log",
  );
  const [drawer, setDrawer] = useState(false);
  const [selectedHand, setSelectedHand] = useState<number | null>(null);
  const [olderHands, setOlderHands] = useState<Hand[]>([]);
  const [olderLogs, setOlderLogs] = useState<Room["logs"]>([]);
  const [handLogs, setHandLogs] = useState<Record<number, Room["logs"]>>({});
  const [logFilter, setLogFilter] = useState("all");
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Date.now() / 1000 + offset.current),
      50,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let ws: WebSocket | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      ping: ReturnType<typeof setInterval> | undefined;
    let cancelled = false,
      revoked = false;
    const accept = (r: Room) => {
      if (cancelled) return;
      offset.current = r.server_time - Date.now() / 1000;
      setRoom(r);
      setNow(r.server_time);
    };
    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/${rid}`,
      );
      ws.onopen = () => {
        setConnection(value => value + 1);
        setStatus("connected");
        ping = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
        }, 5000);
      };
      ws.onmessage = (e) => {
        const message = JSON.parse(e.data);
        if (message.type === "state") accept(message.state);
        if (message.type === "revoked") {
          revoked = true;
          setStatus("revoked");
          ws?.close();
        }
      };
      ws.onclose = (e) => {
        clearInterval(ping);
        if (cancelled) return;
        if (e.code === 1008 || revoked) {
          revoked = true;
          setStatus("revoked");
          return;
        }
        setStatus("offline");
        timer = setTimeout(connect, 1500);
      };
    };
    setStatus("connecting");
    setFailure("");
    api(`/api/rooms/${rid}`)
      .then((r) => {
        accept(r);
        if (!cancelled) connect();
      })
      .catch((e) => setFailure(e.message));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(ping);
      ws?.close();
    };
  }, [rid, epoch]);
  useEffect(() => {
    if (room?.legal?.min_raise) setRaise(room.legal.min_raise);
  }, [room?.hand?.seq, room?.hand?.number]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [room?.logs.length, panel]);

  const send = async (body: object, close = false) => {
    if (status !== "connected") {
      error("当前连接不可用，请等待重连");
      return false;
    }
    setBusy(true);
    try {
      await api(`/api/rooms/${rid}/commands`, {
        ...body,
        command_id: commandId(),
      });
      if (close) setModal(null);
      return true;
    } catch (e) {
      error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const recall = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/rooms/${rid}/recover`, { code });
      setModal(null);
      setEpoch((v) => v + 1);
    } catch (e) {
      error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (failure)
    return (
      <div className="error-page">
        <Spade size={38} />
        <h1>{failure}</h1>
        <button className="primary" onClick={home}>
          <ArrowLeft size={17} />
          返回首页
        </button>
      </div>
    );
  if (!room)
    return (
      <div className="error-page">
        <Spade className="loading-icon" size={38} />
        <p>正在进入房间…</p>
      </div>
    );
  const me = room.players.find((p) => p.id === room.me)!;
  const owner = room.owner === room.me;
  const target = room.players.find(p => p.id === targetSnapshot?.id) || targetSnapshot;
  const hand = room.hand;
  const active = hand && hand.result === null;
  const showWindow = !!(hand?.result && hand.cards[me.id]?.length &&
    now < hand.reveal_until && !room.closed_at);
  const reveal = (cards: number[]) => {
    void send({ type: "show_cards", hand: hand?.number, cards });
  };
  const mayAct = room.legal && !room.recovery && status === "connected";
  const legal = room.legal || { call: 0, fold: false, can_raise: false,
    min_raise: room.settings.bb * 2, max_raise: Math.max(room.settings.bb * 2, me.stack + me.bet) };
  const canRaise = !!mayAct && legal.can_raise && !busy;
  const bettingStage = !!active && me.seat !== null && ["betting", "dealing"].includes(room.phase);
  const pendingApprovals = room.requests.filter(request => !request.approved).length;
  const awaiting = room.requests.find((r) => r.pid === room.me);
  const countdown = Math.max(0, Math.ceil((room.deadline || 0) - now));
  const openSeat = (s: number) => {
    setSeat(s);
    setNickname(
      me.name === "观战者"
        ? localStorage.getItem("river_nickname") || ""
        : me.name,
    );
    setAmount(room.settings.bb * 100);
    setModal("seat");
  };
  const openTopup = () => {
    setAmount(room.settings.bb * 100);
    setModal("topup");
  };
  const wager = (action: string, value?: number) =>
    send({
      type: "act",
      action,
      amount: value,
      hand: hand?.number,
      seq: hand?.seq,
    });
  const stats = room.players.filter(
    (p) => p.buyin || p.buyout || p.seat !== null,
  );
  const histories = [
    ...new Map(
      [...olderHands, ...room.history].map((h) => [h.number, h]),
    ).values(),
  ].sort((a, b) => a.number - b.number);
  const logs = [
    ...new Map([...olderLogs, ...room.logs].map((l) => [l.id, l])).values(),
  ].sort((a, b) => a.id - b.id);
  const loadEarlier = async (kind: "history" | "logs") => {
    try {
      const before = kind === "history" ? histories[0]?.number : logs[0]?.id;
      const data = await api(`/api/rooms/${rid}/${kind}?before=${before}`);
      if (kind === "history") setOlderHands((v) => [...data.hands, ...v]);
      else setOlderLogs((v) => [...data.logs, ...v]);
    } catch (e) {
      error((e as Error).message);
    }
  };
  const showHistory = async (number: number) => {
    setSelectedHand(selectedHand === number ? null : number);
    if (!handLogs[number]) {
      try {
        const data = await api(`/api/rooms/${rid}/logs?hand=${number}`);
        setHandLogs((v) => ({ ...v, [number]: data.logs }));
      } catch (e) {
        error((e as Error).message);
      }
    }
  };
  const panelTabs = [
    { id: "log", icon: History, label: "日志" },
    { id: "stats", icon: Coins, label: "统计" },
    { id: "history", icon: Clipboard, label: "手牌" },
    ...(owner ? [{ id: "manage", icon: Crown, label: "管理" }] : []),
  ];

  return (
    <div className="room-shell">
      <header className="site-header room-header">
        <div className="header-left">
          <IconButton title="返回首页" onClick={home}>
            <ArrowLeft size={18} />
          </IconButton>
          <div className="brand">
            <Spade size={21} fill="currentColor" />
            <span>RIVER ROOM</span>
          </div>
        </div>
        <div className="header-right">
          {owner && pendingApprovals > 0 && <IconButton title={`待审批 ${pendingApprovals} 项`}
            className="approval-button" onClick={() => { setPanel("manage"); setDrawer(true); }}>
            <ShieldCheck size={18} /><span className="approval-count">{pendingApprovals}</span>
          </IconButton>}
          <IconButton title={sound.muted ? "开启发牌音效" : "关闭发牌音效"} onClick={sound.toggle}>
            {sound.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </IconButton>
          <span
            className={`connection ${status}`}
            title={status === "connected" ? "已连接" : "连接中断"}
          >
            {status === "connected" ? (
              <Wifi size={15} />
            ) : (
              <WifiOff size={15} />
            )}
            <span>
              {status === "connected"
                ? "已连接"
                : status === "revoked"
                  ? "已被接管"
                  : "重连中"}
            </span>
          </span>
          <button
            className="share-button"
            aria-label="邀请朋友"
            title="邀请朋友"
            onClick={() => setModal("share")}
          >
            <Link size={16} />
            <span>邀请朋友</span>
          </button>
          <IconButton title="房间身份" onClick={() => setModal("identity")}>
            <KeyRound size={19} />
          </IconButton>
          <IconButton
            title="日志和统计"
            onClick={() => setDrawer(true)}
          >
            <Menu size={20} />
          </IconButton>
        </div>
      </header>
      <div className="room-info">
        <div>
          <h1>{room.name}</h1>
          <span className="room-id">#{rid.slice(0, 6)}</span>
        </div>
        <div className="room-meta">
          <span>
            {room.settings.sb}/{room.settings.bb}
          </span>
          <span>
            <Users size={13} />
            {room.players.filter((p) => p.seat !== null).length}/9
          </span>
          <span className="desktop-only">第 {room.number} 手</span>
          {room.settings.twice && <span className="rule-tag">发两次</span>}
          {room.settings.straddle && <span className="rule-tag">UTG</span>}
        </div>
      </div>
      {status === "revoked" && (
        <div className="connection-banner">
          身份已在另一设备召回。
          <button onClick={() => setModal("recall")}>输入召回码</button>
          <button onClick={() => setEpoch((v) => v + 1)}>以新身份进入</button>
        </div>
      )}
      {status === "offline" && (
        <div className="connection-banner">连接中断，正在重连…</div>
      )}
      <main className="room-main">
        <section className="play-area">
          <div className="table-toolbar">
            <span
              className={`phase-dot ${room.paused || room.recovery ? "paused" : ""}`}
            />
            <span>
              {room.recovery
                ? "恢复暂停"
                : room.paused
                  ? "后续发牌已暂停"
                  : phases[room.phase]}
            </span>
            <span className="toolbar-spacer" />
            {owner && (
              <>
                <IconButton
                  title="房间设置"
                  onClick={() => {
                    setConfig(room.settings);
                    setModal("settings");
                  }}
                >
                  <Settings size={16} />
                </IconButton>
                {room.started && (
                  <IconButton
                    title={
                      room.paused || room.recovery ? "恢复游戏" : "暂停后续发牌"
                    }
                    onClick={() =>
                      send({
                        type: room.paused || room.recovery ? "resume" : "pause",
                      })
                    }
                  >
                    <span>
                      {room.paused || room.recovery ? (
                        <Play size={16} />
                      ) : (
                        <Pause size={16} />
                      )}
                    </span>
                  </IconButton>
                )}
              </>
            )}
          </div>
          <PokerTable
            connection={connection}
            sound={!sound.muted && status === "connected"}
            room={room}
            now={now}
            sit={openSeat}
            reveal={reveal}
            revealing={busy || status !== "connected"}
            select={(p) => {
              setTarget(p);
              setModal("player");
            }}
          />
          <div className="table-footnote">
            <span>NO LIMIT HOLD’EM</span>
            <span>
              <Eye size={13} />{" "}
              {room.players.filter((p) => p.online && p.seat === null).length}{" "}
              人观战
            </span>
          </div>
        </section>
        {drawer && (
          <button
            aria-label="关闭侧栏"
            className="drawer-backdrop"
            onClick={() => setDrawer(false)}
          />
        )}
        <aside className={`side-panel ${drawer ? "open" : ""}`}>
          <div className="panel-tabs">
            {panelTabs.map((t) => (
              <button
                key={t.id}
                aria-label={t.label}
                className={panel === t.id ? "selected" : ""}
                onClick={() => setPanel(t.id as typeof panel)}
              >
                <t.icon size={16} />
                <span>{t.label}</span>
                {t.id === "manage" && room.requests.length > 0 && (
                  <b className="count-badge">{room.requests.length}</b>
                )}
              </button>
            ))}
            <IconButton
              title="关闭侧栏"
              onClick={() => setDrawer(false)}
            >
              <X size={18} />
            </IconButton>
          </div>
          {panel === "log" && (
            <>
              <div className="panel-toolbar">
                <span>房间记录</span>
                <select
                  aria-label="日志筛选"
                  value={logFilter}
                  onChange={(e) => setLogFilter(e.target.value)}
                >
                  <option value="all">全部记录</option>
                  <option value="game">牌局行动</option>
                  <option value="ledger">筹码变动</option>
                  <option value="room">房间动态</option>
                </select>
              </div>
              <div className="log-list" ref={logRef}>
                {logs[0]?.id > 1 && (
                  <button
                    className="text-button wide"
                    onClick={() => loadEarlier("logs")}
                  >
                    加载更早记录
                  </button>
                )}
                {logs
                  .filter((l) => logFilter === "all" || l.kind === logFilter)
                  .map((l) => (
                    <div className={`log-entry ${l.kind}`} key={l.id}>
                      <time>
                        {new Date(l.at * 1000).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                      <p>{l.text}</p>
                    </div>
                  ))}
              </div>
            </>
          )}
          {panel === "stats" && (
            <div className="panel-scroll">
              <div className="panel-toolbar">
                <span>累计筹码</span>
                <a
                  href={`/api/rooms/${rid}/stats.csv`}
                  title="导出 CSV"
                  aria-label="导出 CSV"
                >
                  <ArrowDownToLine size={18} />
                </a>
              </div>
              <div className="stat-total">
                <span>
                  累计买入
                  <strong>{n(stats.reduce((s, p) => s + p.buyin, 0))}</strong>
                </span>
                <span>
                  累计买出
                  <strong>{n(stats.reduce((s, p) => s + p.buyout, 0))}</strong>
                </span>
              </div>
              <div className="stats-table">
                <div className="stats-heading">
                  <span>玩家</span>
                  <span>现有</span>
                  <span>水上 / 水下</span>
                </div>
                {stats.map((p) => (
                  <div className="stat-player" key={p.id}>
                    <div>
                      <b>{p.name}</b>
                      <small>
                        买入 {n(p.buyin)} · 买出 {n(p.buyout)}
                      </small>
                    </div>
                    <span>{n(p.holding)}</span>
                    <b className={p.profit >= 0 ? "positive" : "negative"}>
                      {signed(p.profit)}
                    </b>
                  </div>
                ))}
              </div>
              <h3 className="panel-subtitle">买入 / 买出明细</h3>
              {[...room.ledger].reverse().map((e) => (
                <div className="ledger-row" key={e.id}>
                  <div>
                    <b>{e.name}</b>
                    <small>
                      {new Date(e.at * 1000).toLocaleTimeString("zh-CN")} ·{" "}
                      {e.kind === "buyin"
                        ? "买入"
                        : e.kind === "buyout"
                          ? "买出"
                          : "冲正买入"}
                    </small>
                  </div>
                  <strong>{n(e.amount)}</strong>
                  {owner &&
                    e.kind === "buyin" &&
                    !room.ledger.some((x) => x.reverses === e.id) &&
                    !room.closed_at && (
                      <IconButton
                        title="冲正买入"
                        onClick={() => {
                          setCode(e.id);
                          setModal("reverse");
                        }}
                      >
                        <RotateCcw size={14} />
                      </IconButton>
                    )}
                </div>
              ))}
            </div>
          )}
          {panel === "history" && (
            <div className="panel-scroll">
              <div className="panel-toolbar">
                <span>已完成 {room.number - (active ? 1 : 0)} 手</span>
              </div>
              {room.history.length === 0 && (
                <div className="empty-state">
                  <History size={28} />
                  <span>暂无已完成手牌</span>
                </div>
              )}
              {[...histories].reverse().map((h) => (
                <div className="history-entry" key={h.number}>
                  <button
                    className="history-toggle"
                    onClick={() => showHistory(h.number)}
                  >
                    <b>第 {h.number} 手</b>
                    <span>{h.runouts === 2 ? "发两次" : "常规"}</span>
                    <ChevronDown size={16} />
                  </button>
                  <div className="history-board">
                    {h.boards[0]?.map((c, i) => (
                      <Card key={i} code={c} small />
                    ))}
                  </div>
                  {selectedHand === h.number && (
                    <>
                      <div className="history-board">
                        {h.boards[1]?.map((c, i) => (
                          <Card key={i} code={c} small />
                        ))}
                      </div>
                      {h.result?.map((p) => (
                        <div className="history-player" key={p.pid}>
                          <span>{p.name}</span>
                          <div>
                            {h.cards[p.pid]?.map((c, i) => (
                              <Card key={i} code={c} back={c === null} small />
                            ))}
                          </div>
                          <b className={p.delta >= 0 ? "positive" : "negative"}>
                            {signed(p.delta)}
                          </b>
                        </div>
                      ))}
                      {h.showdown_results?.map((group, index) => <div className="history-pot-result" key={index}>
                        <h3>{potTitle(group, h)}</h3>
                        <WinningHands group={group} hand={h} />
                      </div>)}
                      {(handLogs[h.number] || logs)
                        .filter((l) => l.hand === h.number && l.kind === "game")
                        .map((l) => (
                          <p className="history-log" key={l.id}>
                            {l.text}
                          </p>
                        ))}
                    </>
                  )}
                </div>
              ))}
              {histories[0]?.number > 1 && (
                <button
                  className="text-button wide"
                  onClick={() => loadEarlier("history")}
                >
                  加载更早手牌
                </button>
              )}
            </div>
          )}
          {panel === "manage" && owner && (
            <div className="panel-scroll">
              <div className="panel-toolbar">
                <span>入座 / 补码审批</span>
                <span>{room.requests.length} 条</span>
              </div>
              {room.requests.length === 0 && (
                <div className="empty-state">
                  <ShieldCheck size={28} />
                  <span>暂无待处理申请</span>
                </div>
              )}
              {room.requests.map((r) => (
                <div className="request-item" key={r.id}>
                  <div>
                    <b>{r.name}</b>
                    <small>
                      {r.seat + 1} 号位 · {r.kind === "seat" ? "入座" : "补码"}{" "}
                      {n(r.amount)}
                    </small>
                  </div>
                  {r.approved ? (
                    <span className="subtle">本手后到账</span>
                  ) : (
                    <>
                      <IconButton
                        title={`拒绝 ${r.name}`}
                        disabled={busy}
                        onClick={() => send({ type: "reject", request: r.id })}
                      >
                        <X size={17} />
                      </IconButton>
                      <IconButton
                        title={`批准 ${r.name}`}
                        className="approve"
                        disabled={busy}
                        onClick={() => send({ type: "approve", request: r.id })}
                      >
                        <Check size={18} />
                      </IconButton>
                    </>
                  )}
                </div>
              ))}
              <h3 className="panel-subtitle">房间管理</h3>
              <button
                className="management-row"
                onClick={() => {
                  setConfig(room.settings);
                  setModal("settings");
                }}
              >
                <Settings size={17} />
                房间设置
                <ArrowRight size={15} />
              </button>
              <button
                className="management-row"
                onClick={() => setModal("transfer")}
              >
                <Crown size={17} />
                转让房主
                <ArrowRight size={15} />
              </button>
              <button
                className="management-row danger-text"
                disabled={!!room.closed_at}
                onClick={() => setModal("end")}
              >
                <LogOut size={17} />
                结束房间
                <ArrowRight size={15} />
              </button>
            </div>
          )}
        </aside>
      </main>
      <footer className="action-bar">
        <div className="my-status">
          <div className="my-avatar">
            {me.seat === null ? <Eye size={20} /> : me.name.slice(0, 1)}
          </div>
          <div>
            <b>{me.seat === null ? "观战中" : me.name}</b>
            <span>
              {me.seat === null
                ? `${room.players.filter((p) => p.online).length} 人在线`
                : `筹码 ${n(me.stack)} · BANK ${Math.ceil(me.bank)}s`}
            </span>
          </div>
          {me.seat !== null && (
            <div className="seat-tools">
              <IconButton
                title={me.away ? "回到游戏" : "AWAY"}
                disabled={!!room.closed_at || busy}
                onClick={() => send({ type: "away", value: !me.away })}
              >
                {me.away ? <Play size={18} /> : <Pause size={18} />}
              </IconButton>
              <IconButton
                title="补码"
                disabled={!!awaiting || !!room.closed_at || busy}
                onClick={openTopup}
              >
                <Coins size={18} />
              </IconButton>
              <IconButton
                title="离座"
                disabled={me.leave || !!room.closed_at || busy}
                onClick={() => setModal("leave")}
              >
                <LogOut size={18} />
              </IconButton>
            </div>
          )}
        </div>
        <div className="action-content">
          {room.closed_at ? (
            <div className="finished-label">
              <Check size={18} />
              已完成全部结算
              <button className="secondary" onClick={home}>
                返回首页
              </button>
            </div>
          ) : room.recovery ? (
            <div className="wait-actions">
              <span>等待房主恢复游戏</span>
              {owner && (
                <button
                  className="primary"
                  onClick={() => send({ type: "resume" })}
                >
                  <Play size={17} />
                  恢复游戏
                </button>
              )}
            </div>
          ) : room.phase === "straddle" && room.straddle === me.id ? (
            <div className="prompt-actions">
              <div>
                <b>UTG Straddle {n(room.settings.bb * 2)}？</b>
                <span>{countdown} 秒</span>
              </div>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => send({ type: "straddle", value: false })}
              >
                不 Straddle
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => send({ type: "straddle", value: true })}
              >
                Straddle
              </button>
            </div>
          ) : room.phase === "runout" && hand?.voters.includes(me.id) ? (
            <div className="prompt-actions">
              <div>
                <b>本手发两次牌？</b>
                <span>
                  {Object.keys(hand.votes).length}/{hand.voters.length} 已选择 ·{" "}
                  {countdown}s
                </span>
              </div>
              {me.id in hand.votes ? (
                <span className="waiting-pill">
                  已{hand.votes[me.id] ? "同意" : "拒绝"}，等待其他玩家
                </span>
              ) : (
                <>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => send({ type: "vote", value: false })}
                  >
                    只发一次
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => send({ type: "vote", value: true })}
                  >
                    同意发两次
                  </button>
                </>
              )}
            </div>
          ) : room.rebuy.includes(me.id) ? (
            <div className="prompt-actions">
              <div>
                <b>筹码归零，请重买入</b>
                <span>{countdown}s</span>
              </div>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => send({ type: "leave" })}
              >
                离座
              </button>
              <button
                className="primary"
                disabled={busy || !!awaiting}
                onClick={openTopup}
              >
                {awaiting ? "等待房主审批" : "重买入"}
              </button>
            </div>
          ) : mayAct || bettingStage ? (
            <div className={`betting-area ${!mayAct ? "betting-idle" : ""}`}>
            <div className="bet-controls">
              <div className="raise-options">
                <div className="quick-bets">
                  {[0.5, 0.75, 1].map((f) => (
                    <button
                      key={f}
                      disabled={!canRaise}
                      onClick={() =>
                        setRaise(
                          Math.min(
                            legal.max_raise!,
                            Math.max(
                              legal.min_raise!,
                              Math.ceil(
                                (room.pot + legal.call) * f +
                                  legal.call +
                                  me.bet,
                              ),
                            ),
                          ),
                        )
                      }
                    >
                      {f === 1 ? "底池" : `${f * 100}%`}
                    </button>
                  ))}
                  <button
                    disabled={!canRaise}
                    onClick={() => setRaise(legal.max_raise!)}
                  >
                    全下
                  </button>
                </div>
                <input
                  aria-label="加注滑块"
                  type="range"
                  disabled={!canRaise}
                  min={legal.min_raise || 0}
                  max={legal.max_raise || 1}
                  step="1"
                  value={raise}
                  onChange={(e) => setRaise(Number(e.target.value))}
                />
                <input
                  aria-label="加注金额"
                  className="raise-input"
                  type="number"
                  disabled={!canRaise}
                  min={legal.min_raise || 0}
                  max={legal.max_raise || 1}
                  step="1"
                  value={raise}
                  onChange={(e) => setRaise(Number(e.target.value))}
                />
              </div>
              <div className="bet-buttons">
                <button
                  className="fold-button"
                  disabled={busy || !mayAct || !legal.fold}
                  onClick={() => wager("fold")}
                >
                  弃牌
                </button>
                <button
                  className="call-button"
                  disabled={busy || !mayAct}
                  onClick={() => wager("call")}
                >
                  {legal.call ? `跟注 ${n(legal.call)}` : "过牌"}
                </button>
                <button
                  className="primary"
                  disabled={
                    !canRaise ||
                    raise < (legal.min_raise || 0) ||
                    raise > (legal.max_raise || 0)
                  }
                  onClick={() => wager("raise", raise)}
                >
                  {raise === legal.max_raise
                    ? "全下"
                    : me.bet || legal.call
                      ? "加注到"
                      : "下注"}{" "}
                  {n(raise)}
                </button>
              </div>
            </div>
            {!mayAct && <div className="wait-actions">
              {awaiting ? <>
                <span>{awaiting.approved ? "已批准，本手结束后到账" : "等待房主审批"}</span>
                {!awaiting.approved && <button className="text-button"
                  onClick={() => send({ type: "cancel_request", request: awaiting.id })}>取消申请</button>}
              </> : me.away ? <button className="primary" disabled={busy || me.stack === 0}
                onClick={() => send({ type: "away", value: false })}><Play size={17} />回到游戏</button>
                : <span>{me.leave ? "本手结束后离座结算" : me.folded ? "已弃牌，等待本手结束" : "等待其他玩家行动"}</span>}
            </div>}
            </div>
          ) : (
            <div className={`wait-actions ${showWindow && !awaiting ? "reveal-idle" : ""}`}>
              {awaiting ? (
                <>
                  <span>
                    {awaiting.approved
                      ? "已批准，本手结束后到账"
                      : "等待房主审批"}
                  </span>
                  {!awaiting.approved && (
                    <button
                      className="text-button"
                      onClick={() =>
                        send({ type: "cancel_request", request: awaiting.id })
                      }
                    >
                      取消申请
                    </button>
                  )}
                </>
              ) : !room.started && owner ? (
                <button
                  className="primary"
                  disabled={
                    busy ||
                    room.players.filter(
                      (p) => p.seat !== null && !p.away && p.stack > 0,
                    ).length < 2
                  }
                  onClick={() => send({ type: "start" })}
                >
                  <Play size={18} />
                  开始游戏
                </button>
              ) : me.away ? (
                <button
                  className="primary"
                  disabled={busy || me.stack === 0}
                  onClick={() => send({ type: "away", value: false })}
                >
                  <Play size={17} />
                  回到游戏
                </button>
              ) : (
                <span>
                  {me.leave
                    ? "本手结束后离座结算"
                    : me.seat === null
                      ? "观战中"
                      : !active
                        ? "等待下一手"
                        : hand?.ids.includes(me.id)
                          ? me.folded
                            ? "已弃牌，等待本手结束"
                            : "等待其他玩家行动"
                          : "下一手开始参与"}
                </span>
              )}
            </div>
          )}
          {showWindow && (
            <div className="reveal-actions" role="group" aria-label="本手亮牌">
              <span className="reveal-countdown"><Eye size={15} />{Math.max(0, Math.ceil(hand!.reveal_until - now))}s</span>
              <div className="reveal-choices">
                {hand!.cards[me.id].map((card, i) => {
                  const shown = hand!.shown_cards[me.id]?.includes(i);
                  return (
                    <button
                      className={`reveal-card ${shown ? "is-shown" : ""}`}
                      key={i}
                      title={shown ? "已公开" : `亮出 ${card}`}
                      aria-label={shown ? `${card} 已公开` : `亮出 ${card}`}
                      disabled={busy || status !== "connected" || shown}
                      onClick={() => reveal([i])}
                    >
                      <Card code={card} small />
                      {shown && <Check size={12} className="reveal-mark" />}
                    </button>
                  );
                })}
              </div>
              <button
                className="secondary"
                disabled={busy || status !== "connected" || hand!.revealed.includes(me.id)}
                onClick={() => reveal([0, 1])}
              >
                <Eye size={16} />亮出全部
              </button>
            </div>
          )}
        </div>
      </footer>
      {modal === "seat" && (
        <Modal title={`入座 ${seat + 1} 号位`} close={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              localStorage.setItem("river_nickname", nickname);
              send(
                { type: "request_seat", seat, name: nickname, amount },
                true,
              );
            }}
          >
            <label>
              昵称
              <input
                autoFocus
                maxLength={20}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                required
              />
            </label>
            <label>
              买入筹码
              <input
                type="number"
                min="1"
                step="1"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                required
              />
            </label>
            <button className="primary wide" disabled={busy}>
              {owner ? "确认入座" : "提交入座申请"}
            </button>
          </form>
        </Modal>
      )}
      {(modal === "topup" || modal === "credit") && (
        <Modal
          title={
            modal === "credit"
              ? `为 ${target?.name} 记入买入`
              : me.stack === 0
                ? "重买入"
                : "补码"
          }
          close={() => setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(
                modal === "credit"
                  ? { type: "credit", pid: target?.id, amount }
                  : { type: "topup", amount },
                true,
              );
            }}
          >
            <label>
              买入筹码
              <input
                autoFocus
                type="number"
                min="1"
                step="1"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                required
              />
            </label>
            <button className="primary wide" disabled={busy}>
              确认买入
            </button>
          </form>
        </Modal>
      )}
      {modal === "share" && (
        <Modal title="邀请朋友" close={() => setModal(null)}>
          <CopyField label="邀请链接" value={location.href} notify={error} />
          <div className="modal-meta">
            <span>房间编码</span>
            <code>{rid}</code>
          </div>
        </Modal>
      )}
      {modal === "identity" && (
        <Modal title="房间身份" close={() => setModal(null)}>
          <div className="identity-name">
            <KeyRound size={25} />
            <div>
              <b>{me.name}</b>
              <span>{me.seat === null ? "观战" : `${me.seat + 1} 号位`}</span>
            </div>
          </div>
          <label>
            我的召回码
            <CopyField
              label="我的召回码"
              buttonLabel="复制召回码"
              value={room.recovery_code.match(/.{1,4}/g)?.join("-") || room.recovery_code}
              copyValue={room.recovery_code}
              notify={error}
            />
          </label>
          <button
            className="secondary wide"
            onClick={() => {
              setCode("");
              setModal("recall");
            }}
          >
            <RotateCcw size={17} />
            召回其他身份
          </button>
        </Modal>
      )}
      {modal === "recall" && (
        <Modal title="召回身份" close={() => setModal(null)}>
          <form onSubmit={recall}>
            <label>
              召回码
              <input
                autoFocus
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </label>
            <button className="primary wide" disabled={busy}>
              召回并接管
            </button>
          </form>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title="房间设置" close={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send({ type: "settings", settings: config }, true);
            }}
          >
            <ConfigFields value={config} change={setConfig} />
            <button
              className="primary wide"
              disabled={busy || !!active || room.phase === "straddle"}
            >
              {active ? "本手结束后可修改" : "保存配置"}
            </button>
          </form>
        </Modal>
      )}
      {modal === "player" && target && (
        <Modal title={target.name} close={() => setModal(null)}>
          {target.cards.length > 0 && (
            <div className="player-cards">
              {target.cards.map((c, i) => (
                <Card key={i} code={c} back={c === null} />
              ))}
            </div>
          )}
          <div className="player-details">
            <span>
              座位<b>{target.seat! + 1}</b>
            </span>
            <span>
              筹码<b>{n(target.stack)}</b>
            </span>
            <span>
              净输赢
              <b className={target.profit >= 0 ? "positive" : "negative"}>
                {signed(target.profit)}
              </b>
            </span>
          </div>
          {target.id === me.id && me.seat !== null && <div className="modal-actions personal-actions">
            <button className="secondary" disabled={busy || !!room.closed_at || (me.away && me.stack === 0)}
              onClick={() => send({ type: "away", value: !me.away }, true)}>
              {me.away ? <Play size={16} /> : <Pause size={16} />}{me.away ? "回到游戏" : "AWAY"}
            </button>
            <button className="secondary" disabled={busy || !!awaiting || !!room.closed_at} onClick={openTopup}>
              <Coins size={16} />补码
            </button>
            <button className="secondary" disabled={busy || me.leave || !!room.closed_at} onClick={() => setModal("leave")}>
              <LogOut size={16} />离座
            </button>
          </div>}
          {target.id === me.id && awaiting && <div className="wait-actions personal-request">
            <span>{awaiting.approved ? "已批准，本手结束后到账" : "等待房主审批"}</span>
            {!awaiting.approved && <button className="text-button" disabled={busy}
              onClick={() => send({ type: "cancel_request", request: awaiting.id })}>取消申请</button>}
          </div>}
          {owner && !room.closed_at && (
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => {
                  setAmount(room.settings.bb * 100);
                  setModal("credit");
                }}
              >
                <Coins size={16} />
                记入买入
              </button>
              {target.id !== me.id && (
                <button className="danger" onClick={() => setModal("kick")}>
                  移除玩家
                </button>
              )}
            </div>
          )}
        </Modal>
      )}
      {modal === "transfer" && (
        <Modal title="转让房主" close={() => setModal(null)}>
          <div className="transfer-list">
            {room.players
              .filter((p) => p.id !== room.me && p.online && !p.banned)
              .map((p) => (
                <button
                  className="management-row"
                  key={p.id}
                  onClick={() => {
                    setTarget(p);
                    setModal("transfer-confirm");
                  }}
                >
                  <span>{p.name}</span>
                  <ArrowRight size={17} />
                </button>
              ))}
          </div>
        </Modal>
      )}
      {["leave", "end", "kick", "reverse", "transfer-confirm"].includes(
        modal || "",
      ) && (
        <Modal
          title={
            {
              leave: "离座结算",
              end: "结束房间",
              kick: `移除 ${target?.name}`,
              reverse: "冲正买入",
              "transfer-confirm": "确认转让房主",
            }[modal!]!
          }
          close={() => setModal(null)}
        >
          <p className="confirm-copy">
            {
              {
                leave: active
                  ? "本手结束后将全额买出并释放座位。"
                  : `全额买出 ${n(me.stack)} 筹码并释放座位。`,
                end: "当前手牌结束后，所有玩家全额买出，房间关闭。",
                kick: "本手结束后全额结算并移除该玩家，该身份将无法再次入座。",
                reverse: "撤销这笔尚未使用的全额买入，并将玩家离座。",
                "transfer-confirm": `将房主权限转交给 ${target?.name}。`,
              }[modal!]
            }
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setModal(null)}>
              取消
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                send(
                  {
                    type: modal === "transfer-confirm" ? "transfer" : modal!,
                    pid: target?.id,
                    entry: code,
                  },
                  true,
                )
              }
            >
              确认
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function App() {
  const path = () => location.pathname.match(/^\/r\/([\w-]+)\/?$/)?.[1] || null;
  const [rid, setRid] = useState(path);
  const [toast, setToast] = useState<{ message: string } | null>(null);
  const [toastHost, setToastHost] = useState<HTMLDialogElement | null>(null);
  const notify = useCallback((message: string) => setToast({ message }), []);
  useEffect(() => {
    const update = () => setRid(path());
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const enter = (id: string | null) => {
    history.pushState({}, "", id ? `/r/${id}` : "/");
    setRid(id);
  };
  return (
    <ToastHostContext.Provider value={setToastHost}>
      {rid ? (
        <RoomScreen
          key={rid}
          rid={rid}
          home={() => enter(null)}
          error={notify}
        />
      ) : (
        <Lobby enter={enter} error={notify} />
      )}
      {toast && createPortal(
        <div className={`toast${toastHost ? " modal-toast" : ""}`} role="status">
          <span>{toast.message}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>,
        toastHost || document.body,
      )}
    </ToastHostContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
