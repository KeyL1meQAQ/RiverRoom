"""Seven-deuce side payments, applied after pots and before buyouts/topups."""
from .achievements import main_winner


def rule(config):
    return dict(enabled=config.get('bounty', False), amount=config.get('bounty_amount'))


def settle(room, hand, stacks, now):
    config = hand.get('bounty_rule', {})
    if not config.get('enabled') or not hand['awards']:
        return None
    winner = main_winner(hand)
    cards = hand['dealt'].get(winner, [])
    if (len(cards) != 2 or {c[0] for c in cards} != {'7', '2'}
            or cards[0][1] == cards[1][1]):
        return None
    payments = []
    for index, pid in enumerate(hand['ids']):
        if pid == winner:
            continue
        amount = min(config['amount'], stacks[index])
        stacks[index] -= amount
        payments.append(dict(pid=pid, name=room['players'][pid]['name'], amount=amount))
    total = sum(p['amount'] for p in payments)
    stacks[hand['ids'].index(winner)] += total
    hand['revealed'] = list(dict.fromkeys([*hand['revealed'], winner]))
    return dict(id=f"{room['id']}:{hand['number']}:72", pid=winner,
                name=room['players'][winner]['name'], amount=config['amount'],
                total=total, payments=payments, at=now)
