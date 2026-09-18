"""Room-scoped achievements, derived only from completed hand results."""
import logging

from . import engine

logger = logging.getLogger('river')
VERSION = 2
METRICS = ('wins', 'busts')
RETRY_LIMIT = 8


def initialize(room):
    room.update(achievement_version=VERSION, achievement_hand=0,
                achievement_since={metric: 1 for metric in METRICS},
                achievement_pending={metric: [] for metric in METRICS})
    for player in room['players'].values():
        player['achievements'] = dict(wins=0, busts=0)


def main_winner(hand):
    awards = hand['awards']
    if not awards:
        return zero_pot_winner(hand)
    if any('winners' not in award for award in awards):
        # Legacy amounts alone cannot distinguish a tie with zero-chip winners.
        replay = dict(hand, ops=[])
        state = engine.state_for(replay)
        awards = []
        for name, args in hand['ops']:
            operation = engine.perform(state, name, args)
            if name == 'push_chips':
                awards.append(operation)
        if state.status or not awards:
            raise ValueError('Incomplete historical replay')
    main = [award for award in awards if award['pot'] == 0]
    if not main:
        raise ValueError('Missing main pot')
    expected = set(range(hand.get('runouts') or 1))
    covered = set()
    winners = []
    for award in main:
        board = award['board']
        if board is None:
            # A single surviving hand can receive both runouts in one award.
            if len(main) != 1:
                raise ValueError('Ambiguous main pot boards')
            covered.update(expected)
        else:
            if board in covered or board not in expected:
                raise ValueError('Invalid main pot board')
            covered.add(board)
        indices = award['winners']
        if not indices:
            # Folding wins have no evaluated hand, hence an empty winners list.
            folded = hand.get('folded')
            if folded is None:
                folded = engine.folded_players(hand)
            remaining = [i for i, pid in enumerate(hand['ids']) if pid not in folded]
            recipients = [i for i, amount in enumerate(award['amounts']) if amount > 0]
            if len(remaining) != 1 or remaining != recipients:
                raise ValueError('Missing winner identity')
            indices = remaining
        winners.append(hand['ids'][indices[0]] if len(indices) == 1 else None)
    if covered != expected:
        raise ValueError('Incomplete main pot boards')
    return winners[0] if winners[0] is not None and all(w == winners[0] for w in winners) else None


def zero_pot_winner(hand):
    """An empty award list is valid only for a completed, uncalled blind return."""
    results = hand.get('result') or []
    if (hand.get('awards') != [] or len(results) != len(hand['ids'])
            or {r['pid'] for r in results} != set(hand['ids'])
            or any(type(r.get(key)) is not int or r[key] != 0
                   for r in results for key in ('won', 'delta'))):
        raise ValueError('Missing main pot')
    state = engine.state_for(hand)
    remaining = set(hand['ids']) - set(engine.folded_players(hand, state))
    if state.status or state.stacks != hand['initial'] or state.total_pot_amount or len(remaining) != 1:
        raise ValueError('Invalid zero-pot settlement')
    return remaining.pop()


def busted_players(hand):
    results = {result['pid']: result['delta'] for result in hand['result']}
    ids, initial = hand['ids'], hand['initial']
    if len(initial) != len(ids) or set(results) != set(ids):
        raise ValueError('Incomplete settlement')
    busted = []
    for pid, start in zip(ids, initial):
        end = start + results[pid]
        if type(start) is not int or type(end) is not int or start <= 0 or end < 0:
            raise ValueError('Invalid settlement stack')
        if end == 0:
            busted.append(pid)
    return busted


def reset_metric(room, metric, since):
    # Keep a contiguous, explainable suffix instead of silently skipping holes.
    room['achievement_since'][metric] = since
    for player in room['players'].values():
        player['achievements'][metric] = 0


def record(room, hand, historical=False):
    number = hand['number']
    if hand.get('result') is None or number <= room['achievement_hand']:
        return
    if historical and number != room['achievement_hand'] + 1:
        for metric in METRICS:
            reset_metric(room, metric, number)
    for metric, compute in [('wins', lambda h: [main_winner(h)]), ('busts', busted_players)]:
        try:
            recipients = compute(hand)
            if any(pid is not None and pid not in room['players'] for pid in recipients):
                raise ValueError('Missing participant')
        except Exception:
            logger.warning('Cannot compute %s for room %s hand %s', metric, room['id'], number)
            if historical:
                # Preserve the existing legacy-history policy for data that
                # predates tracked gaps; live failures never reset prior wins.
                reset_metric(room, metric, number + 1)
            else:
                room['achievement_pending'][metric].append(number)
            continue
        for pid in recipients:
            if pid is not None:
                room['players'][pid]['achievements'][metric] += 1
    room['achievement_hand'] = number


def retry_pending(room):
    """Bounded, per-metric retries at settlement/startup, never on every tick."""
    pending = room['achievement_pending']
    if not any(pending.values()):
        return False
    completed = {h['number']: h for h in room['history'] if h.get('result') is not None}
    current = room.get('hand')
    if current and current.get('result') is not None:
        completed.setdefault(current['number'], current)
    changed = False
    for metric, compute in [('wins', lambda h: [main_winner(h)]), ('busts', busted_players)]:
        # Rotate failures so a damaged early record cannot starve later gaps.
        attempts = pending[metric][:RETRY_LIMIT]
        for number in attempts:
            try:
                recipients = compute(completed[number])
                if any(pid is not None and pid not in room['players'] for pid in recipients):
                    raise ValueError('Missing participant')
            except Exception:
                recipients = None
            pending[metric].remove(number)
            if recipients is None:
                pending[metric].append(number)
                continue
            for pid in recipients:
                if pid is not None:
                    room['players'][pid]['achievements'][metric] += 1
            changed = True
        changed = changed or pending[metric][:len(attempts)] != attempts
    return changed


def migrate(room):
    if room.get('achievement_version') == VERSION:
        return False
    if room.get('achievement_version') == 1:
        # Existing verified counters and their explicit start dates remain valid.
        room.update(achievement_version=VERSION,
                    achievement_pending={metric: [] for metric in METRICS})
        return True
    initialize(room)
    # The latest completed hand also appears in history; count it only once.
    completed = {hand['number']: hand for hand in room['history'] if hand.get('result') is not None}
    current = room.get('hand')
    if current and current.get('result') is not None:
        completed.setdefault(current['number'], current)
    for number in sorted(completed):
        record(room, completed[number], historical=True)
    last_completed = room['number'] - int(bool(current and current.get('result') is None))
    if last_completed > room['achievement_hand']:
        for metric in METRICS:
            reset_metric(room, metric, last_completed + 1)
        room['achievement_hand'] = last_completed
    return True
