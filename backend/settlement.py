"""Public, server-timed presentation of an already committed settlement.

These events never move real chips. Their amounts come from the engine and the
actual bonus ledgers, and their starting balances are captured before bonuses.
"""


def accounts(room, hand, state, payouts):
    before = {pid: stack - paid for pid, stack, paid in zip(hand['ids'], state.stacks, payouts)}
    return {pid: dict(pid=pid, name=p['name'], seat=None if p['leave'] else p['seat'],
                     before=before.get(pid, p['stack'])) for pid, p in room['players'].items()}


def timeline(hand, captured, now):
    def order(pid):
        seat = captured[pid]['seat']
        # Dict insertion order preserves round participation order for leavers
        # via the explicit member order below, rather than inventing a seat.
        return (0, (seat - hand['button'] - 1) % 9) if seat is not None else (1, member_order.get(pid, len(member_order)))

    squid = (hand.get('squid') or {}).get('settlement')
    member_order = {m['pid']: i for i, m in enumerate((squid or {}).get('members', []))}
    payouts = [r for r in hand['result'] if r['won'] > 0]
    start = now + 1.5 if payouts else now
    flight = start + (.25 if len(payouts) > 1 else 0)
    events = []
    departed_flight = flight + (.65 if any(captured[r['pid']]['seat'] is not None for r in payouts) else 0)
    for recipient in sorted(payouts, key=lambda r: order(r['pid'])):
        at = flight
        if captured[recipient['pid']]['seat'] is None:
            at = departed_flight
            departed_flight += 1.05
        events.append(dict(kind='pot', source=None, target=recipient['pid'], amount=recipient['won'],
                           start=at, until=at + .65))
    pot_until = max((e['until'] for e in events), default=now)
    cursor = pot_until + .4 if payouts else now
    bounty_at = cursor
    reward = hand.get('bounty')
    if reward:
        for payment in sorted(reward['payments'], key=lambda p: order(p['pid'])):
            if payment['amount']:
                events.append(dict(kind='bounty', source=payment['pid'], target=reward['pid'],
                                   amount=payment['amount'], start=cursor, until=cursor + .18))
                cursor += .18
    squid_at = cursor
    if squid:
        if squid.get('status') == 'settled':
            cursor += 3
        for payment in sorted(squid['payments'], key=lambda p: order(p['pid'])):
            for transfer in sorted(payment['transfers'], key=lambda t: order(t['pid'])):
                if transfer['amount']:
                    events.append(dict(kind='squid', source=payment['pid'], target=transfer['pid'],
                                       amount=transfer['amount'], start=cursor, until=cursor + .18))
                    cursor += .18
    if any(e['kind'] != 'pot' for e in events):
        cursor += .4  # Last receiver's flip must finish before the reveal clock.
    participants = set(hand['ids']) | {e[k] for e in events for k in ('source', 'target') if e[k]}
    return dict(start=now, split_at=start, pot_until=pot_until,
                bounty_at=bounty_at, squid_at=squid_at, until=cursor,
                accounts={pid: captured[pid] for pid in captured if pid in participants}, events=events)
