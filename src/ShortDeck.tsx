import './short-deck.css';

export function ShortDeckRules() {
  return <div className="bounty-rules">
    <p className="rules-intro">使用 6 至 A，共 36 张牌；每人两张底牌，与公共牌组成最佳五张牌。</p>
    <h3>牌型从大到小</h3>
    <p>同花顺 → 四条 → <strong>同花 → 葫芦</strong> → <strong>顺子 → 三条</strong> → 两对 → 一对 → 高牌。</p>
    <p>皇家同花顺是最大的同花顺。<strong>同花大于葫芦，顺子大于三条。</strong></p>
    <aside className="rules-example"><strong>最小顺子</strong>
      <p>A-6-7-8-9 是 9 高顺子，小于 6-7-8-9-10。最大顺子是 10-J-Q-K-A；Q-K-A-6-7 不算顺子。</p>
    </aside>
    <h3>本房间怎么玩</h3>
    <ul>
      <li>沿用大小盲和可选 UTG Straddle，不额外收取全员前注。</li>
      <li>最多 9 人，支持全员同意后发两次牌；已有公共牌共用，剩余公共牌分别发出。</li>
      <li><strong>与 2–7 杂色奖励互斥：</strong>开启短牌会自动关闭奖励。奖励金额保留，切回普通后需手动重新开启。</li>
      <li><strong>修改从下一手生效：</strong>已经开始 Straddle 询问的一手也保持原模式；切换不会中断当前手牌。</li>
      <li>鱿鱼轮次继续，已有标记及结算责任保留；房间手数、输赢、成就和 TimeBank 继续累计。</li>
    </ul>
  </div>;
}
