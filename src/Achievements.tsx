import type { Player, Room } from './types';

const count = (value: number) => value.toLocaleString('zh-CN');

function Badge({ kind, value }: { kind: 'wins' | 'busts'; value: number }) {
  const label = `${kind === 'wins' ? '赢池' : '被清台'} ${count(value)} 次`;
  return <span className={`achievement-badge ${kind}`} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 28 26" aria-hidden="true">
      {kind === 'wins' ? <>
        <path className="badge-outline" d="M6 3H2v5c0 4 3 6 6 6m14-11h4v5c0 4-3 6-6 6M6 2h16v9c0 4-3 7-6 8v3h5v2H7v-2h5v-3c-3-1-6-4-6-8Z" />
      </> : <>
        <path className="badge-outline" d="M15 1a12 12 0 1 0 10 7l-5 2 1-5-6 2Z" />
        <path className="badge-detail" d="m7 3 1 3M2 10l3 1m-2 7 3-1m3 6 1-3m8 3-1-3m7-3-3-1M19 2l-1 2 5-1 3 2" />
      </>}
      <text x="14" y={kind === 'wins' ? '12' : '15'} className={value > 99 ? 'badge-count capped' : 'badge-count'}>
        {value > 99 ? '99+' : value}
      </text>
    </svg>
  </span>;
}

export function AchievementBadges({ player }: { player: Player }) {
  const { wins = 0, busts = 0 } = player.achievements || {};
  if (!wins && !busts) return null;
  return <span className="achievement-badges">
    {wins > 0 && <Badge kind="wins" value={wins} />}
    {busts > 0 && <Badge kind="busts" value={busts} />}
  </span>;
}

export function AchievementDetails({ player, since }: { player: Player; since: Room['achievement_since'] }) {
  const { wins = 0, busts = 0 } = player.achievements || {};
  return <section className="achievement-details" aria-label="玩家成就">
    <div className="achievement-detail wins">
      <div><span>赢池</span><strong>{count(wins)} 次</strong></div>
      <p>独赢主池计一次，对手全部弃牌也计。发两次牌须独赢两组主池；平分、仅赢边池不计。</p>
      {since?.wins > 1 && <small>从第 {count(since.wins)} 手起统计，更早记录不完整。</small>}
    </div>
    <div className="achievement-detail busts">
      <div><span>被清台</span><strong>{count(busts)} 次</strong></div>
      <p>全部底池结算后、补码前筹码归零计一次。全下暂时归零或主动离座不计。</p>
      {since?.busts > 1 && <small>从第 {count(since.busts)} 手起统计，更早记录不完整。</small>}
    </div>
    <p className="achievement-scope">当前房间累计 · 离座再入座与召回后保留</p>
  </section>;
}
