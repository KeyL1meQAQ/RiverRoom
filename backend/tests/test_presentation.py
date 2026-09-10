import copy

import pytest

from backend import engine, game, hands
from backend.app import Service
from backend.store import Store
from backend.tests.test_game import action, finish, settle_dealing
from backend.tests.test_showdown import fixed_table


@pytest.mark.parametrize('holes,board,label', [
    (('As', 'Qh'), (), '高牌[A]'),
    (('As', 'Ah'), (), '一对[A]'),
    (('As', 'Qh'), ('Ah', 'Qc', '2s'), '两对[A,Q]'),
    (('As', 'Ah'), ('Ad', 'Qc', '2s'), '三条[A]'),
    (('As', '2h'), ('3c', '4d', '5s', '9h', 'Tc'), '顺子'),
    (('As', '8s'), ('2s', '5s', 'Js', '9h', 'Tc'), '同花'),
    (('As', 'Ah'), ('Ad', 'Qc', 'Qs'), '葫芦'),
    (('As', 'Ah'), ('Ad', 'Ac', 'Qs'), '四条[A]'),
    (('2s', '3s'), ('4s', '5s', '6s'), '同花顺'),
    (('As', '2s'), ('3s', '4s', '5s'), '同花顺'),
    (('As', 'Ks'), ('Qs', 'Js', 'Ts'), '皇家同花顺'),
])
def test_hand_labels(holes, board, label):
    name, cards = hands.describe(holes, board)
    assert name == label
    if len(holes) + len(board) >= 5:
        assert len(cards) == len(set(cards)) == 5
        assert set(cards) <= set(holes + board)


def test_equivalent_best_five_prefers_board_and_is_stable():
    board = ('Ah', 'Ks', 'Qd', 'Jc', 'Ts')
    first = hands.describe(('Ac', 'Kd'), board)
    assert first == hands.describe(('Ac', 'Kd'), board)
    assert first == ('顺子', board)


def raw_call(room, now):
    hand = room['hand']
    game.command(room, hand['clock']['pid'], dict(type='act', hand=hand['number'],
                 seq=hand['action_seq'], action='call'), now)


def test_table_actions_use_street_totals_and_clear_before_the_next_street(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')])
    raw_call(room, 1001)
    caller = room['hand']['clock']['pid']
    raw_call(room, 1001)
    visible = game.view(room, observer, 1001)
    assert visible['hand']['last_actions'][caller] == '跟注'
    assert next(p for p in visible['players'] if p['id'] == caller)['bet'] == 2
    assert any('跟注 1' in item['text'] for item in visible['logs'])
    raw_call(room, 1001)
    assert room['phase'] == 'dealing'
    assert game.view(room, observer, 1001)['hand']['last_actions'] == {}
    settle_dealing(room)
    assert room['hand']['last_actions'] == {}


@pytest.mark.parametrize('timeout', [False, True])
def test_check_clears_when_player_acts_again_and_does_not_return_after_restore(monkeypatch, tmp_path, timeout):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')])
    for _ in range(3):
        action(room)
    checker = room['hand']['clock']['pid']
    now = room['hand']['clock']['base_until'] - 20
    if timeout:
        now = room['hand']['clock']['until']
        game.tick(room, now)
    else:
        action(room, now=now)
    assert game.view(room, observer, now)['hand']['last_actions'][checker] == '过牌'
    action(room, now=now)
    action(room, 'raise', 10, now=now)
    assert room['hand']['clock']['pid'] == checker
    assert checker not in game.view(room, observer, now)['hand']['last_actions']
    store = Store(f'sqlite:///{tmp_path}/actions.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert checker not in game.view(restored, observer, now)['hand']['last_actions']


def test_table_actions_distinguish_bet_raise_fold_and_allin(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd'), ('Tc', 'Td')])
    for _ in range(4):
        action(room)
    bettor = room['hand']['clock']['pid']
    action(room, 'raise', 10)
    assert room['hand']['last_actions'][bettor] == '下注'
    raiser = room['hand']['clock']['pid']
    action(room, 'raise', 20)
    folder = room['hand']['clock']['pid']
    action(room, 'fold')
    allin = room['hand']['clock']['pid']
    action(room, 'raise', 98)
    labels = game.view(room, observer, 1002)['hand']['last_actions']
    assert bettor not in labels
    assert labels == {raiser: '加注', folder: '弃牌', allin: '全下'}
    action(room, 'fold')
    action(room)
    assert room['hand']['result'] is not None
    assert room['hand']['last_actions'] == {}
    assert room['history'][-1]['last_actions'] == {}


def test_call_for_remaining_stack_is_labeled_allin(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')], stacks=(100, 20, 100))
    action(room, 'raise', 30)
    caller = room['hand']['clock']['pid']
    action(room)
    visible = game.view(room, observer, 1001)
    assert visible['hand']['last_actions'][caller] == '全下'
    assert next(p for p in visible['players'] if p['id'] == caller)['bet'] == 20


def test_flop_blocks_action_and_clock_until_all_three_cards_finish(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    raw_call(room, 1001)
    raw_call(room, 1001)
    hand = room['hand']
    assert room['phase'] == 'dealing'
    assert hand['deal']['previous'] == [0]
    assert room['deadline'] == 1001.75
    assert hand['clock'] is None and hand['result'] is None
    bank = {pid: room['players'][pid]['bank'] for pid in ids}
    for pid in [*ids, observer]:
        state = game.view(room, pid, 1001.5)
        assert state['legal'] is None
        assert not any('公共牌 ' in item['text'] for item in state['logs'])
    with pytest.raises(game.GameError, match='当前不能'):
        game.command(room, ids[0], dict(type='act', hand=1, seq=hand['action_seq'], action='call'), 1001.5)
    game.tick(room, 1001.749)
    assert room['phase'] == 'dealing'
    game.tick(room, 1001.75)
    assert room['phase'] == 'betting'
    assert hand['clock']['base_until'] == 1021.75
    assert {pid: room['players'][pid]['bank'] for pid in ids} == bank


def test_allin_deals_streets_before_result_and_preserves_window(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    action(room, 'raise', 100)
    raw_call(room, 1001)
    stages = []
    while room['phase'] == 'dealing':
        hand = room['hand']
        stages.append(len(hand['boards'][0]))
        assert hand['result'] is None and not room['history']
        assert not hand['awards']
        game.tick(room, room['deadline'])
    assert stages == [3, 4, 5]
    assert hand['finished_at'] == 1002.25
    assert hand['reveal_until'] == 1007.25
    assert room['deadline'] == 1022.25
    assert hand['showdown_results'][0]['winners'][0]['label'] == '一对[A]'


def test_all_tied_winners_and_board_only_best_five(monkeypatch):
    board = ('Ts', 'Js', 'Qs', 'Ks', 'As')
    room, ids, observer = fixed_table(monkeypatch, [('2c', '3d'), ('4c', '5d'), ('6c', '7d')], board=board)
    finish(room)
    results = game.view(room, observer, 1003)['hand']['showdown_results']
    assert len(results) == 1
    assert [w['pid'] for w in results[0]['winners']] == ids
    for winner in results[0]['winners']:
        assert winner['label'] == '皇家同花顺'
        assert winner['cards'] == list(board)


def test_main_and_side_pot_have_their_own_best_five(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')], stacks=(200, 40, 100))
    action(room, 'raise', 200)
    action(room)
    action(room)
    groups = room['hand']['showdown_results']
    assert groups[0]['pot'] == 0
    assert groups[0]['winners'][0]['pid'] == ids[0]
    assert groups[0]['winners'][0]['label'] == '一对[A]'
    assert groups[1]['pot'] == 1
    assert groups[1]['winners'][0]['pid'] == ids[1]
    assert groups[1]['winners'][0]['label'] == '一对[K]'
    assert len(groups[0]['winners'][0]['cards']) == 5


def test_zero_chip_tied_winner_is_still_listed_on_both_boards(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('2c', '3d'), ('4c', '5d'), ('6c', '7d')],
        stacks=(1, 1, 1), board=('Ts', 'Js', 'Qs', 'Ks', 'As'),
        board2=('Th', 'Jh', 'Qh', 'Kh', 'Ah'), twice=True)
    action(room)
    assert room['phase'] == 'runout'
    for pid in ids:
        game.command(room, pid, {'type': 'vote', 'value': True}, 1002)
    settle_dealing(room)
    groups = room['hand']['showdown_results']
    assert len(groups) == 2
    assert [w['amount'] for w in groups[0]['winners']] == [1, 1, 0]
    assert [w['amount'] for w in groups[1]['winners']] == [1, 0, 0]
    assert all([w['pid'] for w in group['winners']] == ids for group in groups)


def test_merged_runout_payout_is_expanded_for_display(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')], twice=True,
                              board2=('2d', '3s', '6h', '7d', '8s'))
    action(room, 'raise', 100)
    action(room)
    for pid in ids:
        game.command(room, pid, {'type': 'vote', 'value': True}, 1002)
    settle_dealing(room)
    assert room['hand']['awards'][0]['board'] is None
    groups = room['hand']['showdown_results']
    assert [g['board'] for g in groups] == [0, 1]
    assert [g['winners'][0]['amount'] for g in groups] == [100, 100]
    assert all(g['winners'][0]['pid'] == ids[0] for g in groups)


def test_twice_reuses_flop_without_dealing_it_again(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')], twice=True)
    action(room)
    action(room)
    prefix = room['hand']['boards'][0][:]
    assert len(prefix) == 3
    action(room, 'raise', 98)
    action(room)
    for pid in ids:
        game.command(room, pid, dict(type='vote', value=True), 1003)
    stages = []
    while room['phase'] == 'dealing':
        hand = room['hand']
        previous = hand['deal']['previous']
        stages.append([(b, len(board)) for b, board in enumerate(hand['boards']) if len(board) > previous[b]])
        game.tick(room, room['deadline'])
    assert stages == [[(0, 4)], [(0, 5)], [(1, 4)], [(1, 5)]]
    assert all(board[:3] == prefix for board in hand['boards'])
    assert {g['board'] for g in hand['showdown_results']} == {0, 1}


def test_folded_hint_updates_privately_and_stays_out_of_history(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')],
                                      board=('2h', '5s', '9d', 'Qs', '3h'))
    folded = room['hand']['clock']['pid']
    assert folded == ids[2]
    action(room, 'fold')
    assert game.view(room, folded, 1001)['hand']['own_hand_labels'] == [['一对[Q]']]
    finish(room)
    state = game.view(room, folded, 1005)
    assert state['hand']['own_hand_labels'][0][-1] == '三条[Q]'
    assert 'own_hand_labels' not in state['history'][0]
    public = game.view(room, observer, 1005)
    assert public['hand']['own_hand_labels'] == []
    assert folded not in public['hand']['cards']
    assert all(w['pid'] != folded for g in public['hand']['showdown_results'] for w in g['winners'])


def test_fold_win_never_publishes_winner_hand_description(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    action(room, 'fold')
    for state in [game.view(room, observer, 1002)['hand'], game.public_hand(room['history'][0], observer)]:
        assert state['showdown_results'] == []
        assert state['cards'] == {}


def test_deal_restart_keeps_cards_and_resumes_with_full_action_time(monkeypatch, tmp_path):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    raw_call(room, 1001)
    raw_call(room, 1001)
    before = copy.deepcopy(room['hand'])
    store = Store(f'sqlite:///{tmp_path}/presentation.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert restored['recovery']
    assert restored['hand']['boards'] == before['boards']
    game.command(restored, restored['owner'], {'type': 'resume'}, 1010)
    assert restored['phase'] == 'betting'
    assert restored['hand']['boards'] == before['boards']
    assert restored['hand']['clock']['base_until'] == 1030
    assert restored['hand']['deal'] is None
