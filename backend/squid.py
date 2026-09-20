"""Persisted, room-scoped squid rounds. Balances remain in the room ledger domain."""
import copy


def rule(config):
    return dict(enabled=config.get('squid', False), amount=config.get('squid_amount'),
                reveal=config.get('squid_reveal', False))


def migrate(room):
    changed = False
    for key, value in [('squid', False), ('squid_amount', None), ('squid_reveal', False)]:
        if key not in room['settings']:
            room['settings'][key] = value
            changed = True
    for key, value in [('squid_round', None), ('squid_number', 0), ('squid_history', [])]:
        if key not in room:
            room[key] = value
            changed = True
    # Only unfinished rounds adopt the single-token rule; settled ledgers stay intact.
    for m in (room.get('squid_round') or {}).get('members', []):
        if m['count'] > 1:
            m['count'] = 1
            changed = True
    return changed


def member(room, pid):
    return next((m for m in (room.get('squid_round') or {}).get('members', []) if m['pid'] == pid), None)


def begin_hand(room, hand, config, now):
    hand['squid_rule'] = copy.deepcopy(config)
    if not config['enabled']:
        return
    current = room.get('squid_round')
    if current is None:
        room['squid_number'] += 1
        current = dict(number=room['squid_number'], total=-1, members=[],
                       started_hand=hand['number'], at=now, amount=config['amount'])
        room['squid_round'] = current
    current['amount'] = config['amount']
    for pid in hand['ids']:
        if member(room, pid) is None:
            current['members'].append(dict(pid=pid, name=room['players'][pid]['name'], count=0))
            current['total'] += 1
    hand['squid_round_number'] = current['number']


def first_main_winner(hand):
    # Never infer a unique winner from nonzero payouts: tied players can receive
    # zero chips after integer splitting. Only the first board awards count.
    main = [a for a in hand['awards'] if a['pot'] == 0 and a['board'] in (None, 0)]
    if len(main) != 1:
        return None
    award = main[0]
    winners = award.get('winners', [])
    if not winners:
        remaining = [i for i, pid in enumerate(hand['ids']) if pid not in hand['folded']]
        recipients = [i for i, amount in enumerate(award['amounts']) if amount > 0]
        winners = remaining if remaining == recipients and len(remaining) == 1 else []
    return hand['ids'][winners[0]] if len(winners) == 1 else None


def distribute(amount, weights):
    """Largest remainder, with the stable round order breaking equal remainders."""
    total = sum(weights)
    shares = [amount * weight // total for weight in weights]
    order = sorted(range(len(weights)), key=lambda i: -(amount * weights[i] % total))
    for index in order[:amount - sum(shares)]:
        shares[index] += 1
    return shares


def archive(room, current, status, now, hand_number, **extra):
    event = dict(copy.deepcopy(current), id=f"{room['id']}:squid:{current['number']}",
                 status=status, finished_hand=hand_number, finished_at=now, **extra)
    room['squid_history'].append(event)
    room['squid_round'] = None
    return event


def cancel(room, now, reason):
    current = room.get('squid_round')
    if current is None:
        return None
    return archive(room, current, 'cancelled', now, room['number'], reason=reason,
                   payments=[], results=[])


def finish_hand(room, hand, now):
    current = room.get('squid_round')
    config = hand.get('squid_rule', rule({}))
    if (not config['enabled'] or current is None
            or current['number'] != hand.get('squid_round_number')):
        return None
    current['amount'] = config['amount']
    winner = first_main_winner(hand)
    winner_member = member(room, winner)
    if winner_member is None or winner_member['count']:
        return None
    winner_member['count'] = 1
    if config['reveal']:
        hand['revealed'] = list(dict.fromkeys([*hand['revealed'], winner]))
    award = dict(pid=winner, name=room['players'][winner]['name'], count=winner_member['count'],
                 round=current['number'], total=current['total'],
                 issued=sum(m['count'] for m in current['members']), at=now,
                 id=f"{room['id']}:{hand['number']}:squid")
    event = dict(award=award, settlement=None)
    if sum(m['count'] == 0 for m in current['members']) != 1:
        return event
    holders = [m for m in current['members'] if m['count']]
    weights = [m['count'] for m in holders]
    before = {m['pid']: room['players'][m['pid']]['stack'] for m in current['members']}
    payments = []
    due = current['total'] * config['amount']
    for m in current['members']:
        if m['count']:
            continue
        payer = room['players'][m['pid']]
        paid = min(payer['stack'], due)
        payer['stack'] -= paid
        transfers = []
        for holder, share in zip(holders, distribute(paid, weights)):
            room['players'][holder['pid']]['stack'] += share
            transfers.append(dict(pid=holder['pid'], name=room['players'][holder['pid']]['name'],
                                  due=holder['count'] * config['amount'], amount=share))
        payments.append(dict(pid=payer['id'], name=payer['name'], due=due, amount=paid, transfers=transfers))
    results = [dict(pid=m['pid'], name=room['players'][m['pid']]['name'], count=m['count'],
                    before=before[m['pid']], after=room['players'][m['pid']]['stack'],
                    delta=room['players'][m['pid']]['stack'] - before[m['pid']]) for m in current['members']]
    if sum(r['delta'] for r in results) != 0 or any(r['after'] < 0 for r in results):
        raise ValueError('鱿鱼结算筹码不守恒')
    event['settlement'] = archive(room, current, 'settled', now, hand['number'],
                                  payments=payments, results=results)
    hand['squid_busted'] = [r['pid'] for r in results if r['before'] > 0 and r['after'] == 0]
    return event
