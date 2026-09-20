import copy

import pytest

from backend import game
from backend.app import Service
from backend.store import Store
from backend.tests.test_game import action, settle_dealing
from backend.tests.test_presentation import raw_call
from backend.tests.test_showdown import fixed_table


@pytest.mark.parametrize('prefix', [0, 3, 4, 5])
@pytest.mark.parametrize('timeout', [False, True])
def test_final_check_preserves_table_without_future_cards_or_clock(monkeypatch, prefix, timeout):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    while len(room['hand']['boards'][0]) < prefix:
        action(room)
    action(room)
    hand = room['hand']
    checker = hand['clock']['pid']
    now = hand['clock']['until'] if timeout else hand['clock']['base_until'] - 20
    if timeout:
        game.tick(room, now)
    else:
        raw_call(room, now)
    assert room['phase'] == 'action_hold'
    assert room['deadline'] == now + 1.5
    bank = {pid: room['players'][pid]['bank'] for pid in ids}
    for viewer in [*ids, observer]:
        snapshot = game.view(room, viewer, now + 1)
        assert snapshot['hand']['last_actions'][checker] == '过牌'
        assert len(snapshot['hand']['boards'][0]) == prefix
        assert snapshot['hand']['clock'] is None and snapshot['legal'] is None
        assert snapshot['hand']['result'] is None and snapshot['hand']['awards'] == []
        assert snapshot['hand']['revealed'] == []
        assert snapshot['history'] == []
        assert snapshot['pot'] == 4
        assert all(p['bet'] == (2 if prefix == 0 else 0) for p in snapshot['players'] if p['id'] in ids)
        with pytest.raises(game.GameError, match='当前不能'):
            game.command(room, viewer, dict(type='act', action='call', hand=1, seq=hand['action_seq']), now + 1)
    before = copy.deepcopy(hand)
    game.tick(room, now + 1.499)
    assert hand == before
    game.tick(room, now + 1.5)
    assert hand['last_actions'] == {} and 'action_display' not in hand
    assert room['phase'] == ('between' if prefix == 5 else 'dealing')
    assert {pid: room['players'][pid]['bank'] for pid in ids} == bank
    if prefix < 5:
        assert hand['deal']['start'] == now + 1.5
        end = room['deadline']
        game.tick(room, end)
        assert hand['clock']['base_until'] == end + 20
    else:
        assert len(room['history']) == 1
        assert sum(p['stack'] for p in room['players'].values()) == 200


@pytest.mark.parametrize('kind', ['call', 'fold'])
@pytest.mark.parametrize('twice', [False, True])
def test_final_action_retains_amounts_and_no_early_refund_or_payment(monkeypatch, kind, twice):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')], stacks=(100, 40), twice=twice)
    action(room, 'raise', 100)
    hand = room['hand']
    caller = hand['clock']['pid']
    game.command(room, caller, dict(type='act', action=kind, hand=1, seq=hand['action_seq']), 1001)
    voting = twice and kind == 'call'
    assert room['phase'] == ('runout' if voting else 'action_hold')
    assert room['deadline'] == 1001 + (15 if voting else 1.5)
    visible = game.view(room, observer, 1001)
    participants = {p['id']: p for p in visible['players'] if p['id'] in ids}
    assert participants[caller]['stack'] == (0 if kind == 'call' else 38)
    assert participants[caller]['bet'] == (40 if kind == 'call' else 2)
    other = next(pid for pid in ids if pid != caller)
    assert participants[other]['stack'] == 0 and participants[other]['bet'] == 100
    assert visible['pot'] == (140 if kind == 'call' else 102)
    assert visible['hand']['last_actions'][caller] == ('全下' if kind == 'call' else '弃牌')
    assert not visible['hand']['revealed'] and visible['hand']['boards'] == [[]]
    assert hand['result'] is None and hand['awards'] == []
    if voting:
        for pid in ids:
            game.command(room, pid, dict(type='vote', value=True), 1001.1)
        assert room['phase'] == 'dealing'
        assert set(hand['revealed']) == set(ids)
        assert 'action_display' not in hand
    else:
        game.tick(room, 1002.499)
        assert room['phase'] == 'action_hold'
        game.tick(room, 1002.5)
        assert room['phase'] == ('dealing' if kind == 'call' else 'between')
    settle_dealing(room)
    assert sum(p['stack'] for p in room['players'].values()) == 140
    assert len(room['history']) == 1 and 'action_display' not in room['history'][0]


@pytest.mark.parametrize('resume_at', [1001.2, 1010])
def test_hold_survives_storage_and_restart_without_reset(monkeypatch, tmp_path, resume_at):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    raw_call(room, 1001)
    raw_call(room, 1001)
    store = Store(f'sqlite:///{tmp_path}/hold.db')
    store.save(room)
    loaded = store.all()[0]
    assert game.view(loaded, observer, 1001.25) == game.view(room, observer, 1001.25)
    game.tick(loaded, 1002.499)
    assert loaded['phase'] == 'action_hold'
    restored = Service(store).rooms[room['id']]
    assert restored['recovery']
    game.tick(restored, 1010)
    assert restored['phase'] == 'action_hold'
    game.command(restored, room['owner'], dict(type='resume'), resume_at)
    if resume_at < 1002.5:
        assert restored['phase'] == 'action_hold' and restored['deadline'] == 1002.5
        game.tick(restored, 1002.5)
    assert restored['phase'] == 'dealing'
    assert restored['hand']['deal']['start'] == max(resume_at, 1002.5)
    assert len(restored['hand']['boards'][0]) == 3
    settle_dealing(restored)
    assert restored['phase'] == 'betting'


def test_timeout_fold_and_room_end_wait_for_hold_and_settlement(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    actor = room['hand']['clock']['pid']
    deadline = room['hand']['clock']['until']
    game.tick(room, deadline)
    assert room['hand']['last_actions'][actor] == '弃牌'
    assert room['phase'] == 'action_hold'
    game.command(room, room['owner'], dict(type='pause'), deadline + .1)
    game.command(room, actor, dict(type='leave'), deadline + .2)
    game.command(room, room['owner'], dict(type='end'), deadline + .3)
    assert room['closed_at'] is None and room['players'][actor]['seat'] is not None
    game.tick(room, deadline + 1.5)
    assert room['hand']['result'] is not None and room['players'][actor]['seat'] is None
    game.tick(room, room['hand']['reveal_until'])
    assert room['closed_at'] is not None
    assert sum(p['buyout'] for p in room['players'].values()) == 200
