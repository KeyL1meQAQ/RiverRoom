import { useRef, useState } from 'react';
import type { PreAction, PreActionState } from './types';

const choices: { action: PreAction; label: string }[] = [
  { action: 'call', label: '跟注' },
  { action: 'check', label: '过牌' },
  { action: 'fold', label: '弃牌' },
  { action: 'check_or_fold', label: '过牌或弃牌' },
];

export function PreActions({ state, connected, busy, send }: {
  state: PreActionState;
  connected: boolean;
  busy: boolean;
  send: (body: object) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const choose = async (action: PreAction) => {
    if (pending.current || busy || !connected) return;
    pending.current = true;
    setSaving(true);
    try {
      await send({ type: 'pre_action', hand: state.hand, street: state.street,
        revision: state.revision, action: state.selected === action ? null : action });
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return <div className="pre-actions" role="group" aria-label="预行动" aria-busy={saving}>
    <span className="pre-action-status" role="status">{saving ? '保存中…' : '预行动'}</span>
    {choices.map(({ action, label }) => <button key={action} type="button"
      className={`pre-action-choice pre-action-${action}`}
      aria-label={action === 'call' ? '跟注任意金额' : label}
      title={action === 'call' ? '跟注任意金额，筹码不足则全下' : undefined}
      aria-pressed={state.selected === action}
      disabled={!connected || busy || saving || (state.selected !== action && !state.options.includes(action))}
      onClick={() => void choose(action)}>
      {action === 'call' ? <>{label}<span className="pre-call-detail">任意金额</span></> : label}
    </button>)}
  </div>;
}
