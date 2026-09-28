"""Private, persisted intentions for one betting opportunity in one street."""


def options(room, pid, state):
    hand = room['hand']
    player = room['players'][pid]
    if (room['phase'] != 'betting' or not hand or hand['result'] is not None
            or state is None or state.actor_index is None or pid not in hand['ids']
            or player['seat'] is None):
        return []
    index = hand['ids'].index(pid)
    if not state.statuses[index] or state.stacks[index] <= 0:
        return []
    return ['call' if max(state.bets) > state.bets[index] else 'check', 'fold', 'check_or_fold']


def replace(player, intent):
    player['pre_action'] = intent
    player['pre_action_revision'] = player.get('pre_action_revision', 0) + 1


def prune(room, state):
    hand = room['hand']
    changed = False
    for pid, player in room['players'].items():
        intent = player.get('pre_action')
        if intent and (not hand or intent['hand'] != hand['number']
                       or state is None or intent['street'] != state.street_index
                       or intent['action'] not in options(room, pid, state)):
            replace(player, None)
            changed = True
    return changed


def view(room, pid, state):
    available = options(room, pid, state)
    if not available:
        return None
    player = room['players'][pid]
    selected = player.get('pre_action')
    if room['hand']['ids'][state.actor_index] == pid and not selected:
        return None
    return dict(hand=room['hand']['number'], street=state.street_index,
                revision=player.get('pre_action_revision', 0),
                selected=selected['action'] if selected else None,
                options=[] if room['recovery'] else available)
