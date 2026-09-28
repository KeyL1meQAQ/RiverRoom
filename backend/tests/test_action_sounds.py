import asyncio
import copy

import pytest

from backend import game
from backend.app import Service
from backend.store import Store
from backend.tests.test_game import table, settle_dealing


def started(stacks=(100, 100), **settings):
    room, ids = table(stacks, **settings)
    game.command(room, ids[0], {'type': 'start'}, 1000)
    return room, ids


def act(room, kind='call', amount=None, now=1001):
    hand = room['hand']
    game.command(room, hand['clock']['pid'], dict(type='act', hand=hand['number'],
                 seq=hand['action_seq'], action=kind, amount=amount), now)


def test_call_and_last_check_are_distinct_public_events_without_relying_on_next_clock():
    room, ids = started()
    observer = game.add_player(room, 'observer', 1000)['id']
    assert game.view(room, observer, 1000)['hand']['action_events'] == []
    actor = room['hand']['clock']['pid']
    act(room)
    checker = room['hand']['clock']['pid']
    last_seq = room['hand']['action_seq']
    act(room, now=1001.1)
    assert room['phase'] == 'action_hold'
    assert room['hand']['action_seq'] == last_seq
    expected = [dict(seq=last_seq - 1, pid=actor, kind='chips', at=1001),
                dict(seq=last_seq, pid=checker, kind='check', at=1001.1)]
    for viewer in [*ids, observer]:
        assert game.view(room, viewer, 1001.1)['hand']['action_events'] == expected
    settle_dealing(room)
    assert room['hand']['action_events'] == expected
    assert 'action_events' not in game.public_hand(room['hand'], observer)


@pytest.mark.parametrize('twice', [False, True])
def test_all_in_raise_and_short_call_each_emit_once_even_before_runout_vote(twice):
    room, _ = started((100, 40), twice=twice)
    act(room, 'raise', 100)
    act(room, now=1001.1)
    assert room['phase'] == ('runout' if twice else 'action_hold')
    assert [event['kind'] for event in room['hand']['action_events']] == ['chips', 'chips']
    assert len({event['seq'] for event in room['hand']['action_events']}) == 2


@pytest.mark.parametrize('check', [False, True])
def test_timeout_emits_only_for_automatic_check(check):
    room, _ = started()
    if check:
        act(room)
    before = copy.deepcopy(room['hand'].get('action_events', []))
    clock = room['hand']['clock'].copy()
    game.tick(room, clock['until'])
    events = room['hand'].get('action_events', [])
    assert len(events) == len(before) + int(check)
    if check:
        assert events[-1]['kind'] == 'check' and events[-1]['pid'] == clock['pid']
    game.tick(room, clock['until'] + .1)
    assert room['hand'].get('action_events', []) == events


def test_invalid_action_and_fold_have_no_sound_and_old_hands_need_no_migration():
    room, _ = started()
    assert 'action_events' not in room['hand']
    before = copy.deepcopy(room)
    with pytest.raises(game.GameError):
        act(room, 'raise', 1)
    assert room == before
    act(room, 'fold')
    assert game.view(room, room['owner'], 1001)['hand']['action_events'] == []


def test_failed_save_never_publishes_or_consumes_an_action_event(tmp_path, monkeypatch):
    room, _ = started()
    store = Store(f'sqlite:///{tmp_path}/sounds.db')
    service = Service(store)
    store.save(room)
    service.rooms[room['id']] = room
    published = []

    async def publish(rid):
        published.append(copy.deepcopy(service.rooms[rid]['hand']['action_events']))

    service.publish = publish
    original = store.save

    def fail(*args):
        raise RuntimeError('save failed')

    monkeypatch.setattr(store, 'save', fail)
    with pytest.raises(RuntimeError, match='save failed'):
        asyncio.run(service.mutate(room['id'], act))
    assert published == [] and 'action_events' not in service.rooms[room['id']]['hand']
    monkeypatch.setattr(store, 'save', original)
    asyncio.run(service.mutate(room['id'], act))
    assert len(published) == 1 and len(published[0]) == 1
    assert store.all()[0]['hand']['action_events'] == published[0]
