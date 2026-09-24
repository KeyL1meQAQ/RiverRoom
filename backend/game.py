import copy
import secrets
import time

from . import achievements, bounty, engine, equity, hands, squid, settlement

MAX_INTEGER = 9_007_199_254_740_991
RUNOUT_STREET_PAUSE = 1.5
LAST_ACTION_PAUSE = 1.5
DEFAULTS = dict(sb=1, bb=2, timebank=10, refill=20, straddle=False, twice=False, short_deck=False,
                bounty=False, bounty_amount=None, squid=False, squid_amount=None, squid_reveal=False)


class GameError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise GameError(message)


def integer(value, minimum=0, maximum=MAX_INTEGER):
    require(type(value) is int and minimum <= value <= maximum, '请输入有效的整数')
    return value


def clean_name(value, fallback=''):
    require(isinstance(value, str), '名称格式不正确')
    value = value.strip() or fallback
    require(0 < len(value) <= 20, '名称需要 1–20 个字符')
    require(not any(ord(c) < 32 for c in value), '名称包含无效字符')
    return value


def settings(value):
    require(isinstance(value, dict), '房间配置格式不正确')
    result = {**DEFAULTS, **{k: v for k, v in value.items() if k in DEFAULTS}}
    integer(result['sb'], 1)
    integer(result['bb'], result['sb'], MAX_INTEGER // 4)
    integer(result['timebank'], 0, 600)
    integer(result['refill'], 1, 10000)
    require(type(result['straddle']) is bool and type(result['twice']) is bool, '开关格式不正确')
    require(type(result['bounty']) is bool, '奖励开关格式不正确')
    require(type(result['short_deck']) is bool, '短牌开关格式不正确')
    require(not (result['short_deck'] and result['bounty']), '短牌模式与2–7杂色奖励不能同时开启')
    if result['bounty_amount'] is None and result['bounty']:
        result['bounty_amount'] = result['bb']
    if result['bounty_amount'] is not None:
        integer(result['bounty_amount'], 1)
    require(type(result['squid']) is bool and type(result['squid_reveal']) is bool, '鱿鱼开关格式不正确')
    if result['squid_amount'] is None and result['squid']:
        result['squid_amount'] = result['bb']
    if result['squid_amount'] is not None:
        integer(result['squid_amount'], 1, MAX_INTEGER // 500)
    return result


def migrate_bounty(room):
    """Old rooms and already-prepared hands never acquire a retroactive bounty."""
    changed = False
    for key in ('bounty', 'bounty_amount'):
        if key not in room['settings']:
            room['settings'][key] = DEFAULTS[key]
            changed = True
    return changed


def migrate_short_deck(room):
    # Missing per-hand/offer fields mean standard poker, never room.settings.
    if 'short_deck' not in room['settings']:
        room['settings']['short_deck'] = False
        return True
    return False


def log(room, text, now, kind='game'):
    room['logs'].append(dict(id=len(room['logs']) + 1, at=now, hand=room['number'], kind=kind, text=text))


def add_player(room, browser, now):
    for p in room['players'].values():
        if p['browser'] == browser:
            return p
    require(len(room['players']) < 500, '房间参与者数量已达上限')
    pid = secrets.token_urlsafe(9)
    p = dict(id=pid, browser=browser, code=secrets.token_hex(8).upper(), name='观战者', seat=None,
             stack=0, buyin=0, buyout=0, profit=0, away=False, offline=now, online=False,
             bank=room['settings']['timebank'], hands=0, first_seat=True, leave=False,
             banned=False, seen=[], last_seen=now, achievements=dict(wins=0, busts=0))
    room['players'][pid] = p
    return p


def migrate_kicked_players(room):
    changed = False
    for player in room['players'].values():
        if player.get('banned'):
            player['banned'] = False
            changed = True
    return changed


def create_room(name, config, browser, now=None):
    now = now or time.time()
    room = dict(id=secrets.token_urlsafe(9), name=clean_name(name, '好友牌桌'), settings=settings(config),
                players={}, owner=None, requests=[], ledger=[], logs=[], history=[], hand=None,
                phase='waiting', deadline=None, straddle_offer=None, rebuy=[], button=None,
                small_blind=None, big_blind=None, number=0, started=False, paused=False,
                recovery=False, resume_phase=None, closing=False, closed_at=None,
                empty_since=now, created=now, version=0)
    achievements.initialize(room)
    squid.migrate(room)
    owner = add_player(room, browser, now)
    room['owner'] = owner['id']
    log(room, '房间已创建', now, 'room')
    return room


def in_hand(room, pid):
    return bool(room['hand'] and room['hand']['result'] is None and pid in room['hand']['ids'])


def post_ledger(room, p, kind, amount, now, by, reverses=None):
    integer(amount, 1)
    if kind == 'buyin':
        require(sum(x['buyin'] for x in room['players'].values()) + amount <= MAX_INTEGER, '筹码总量超出可精确表示的范围')
        p['stack'] += amount
        p['buyin'] += amount
    elif kind == 'buyout':
        require(amount == p['stack'], '买出必须离座并全额结算')
        p['stack'] = 0
        p['buyout'] += amount
    elif kind == 'reverse_buyin':
        require(not in_hand(room, p['id']) and p['stack'] >= amount, '余额不足或仍在手牌中，不能冲正')
        p['stack'] -= amount
        p['buyin'] -= amount
    else:
        raise GameError('不支持此账目操作')
    entry = dict(id=secrets.token_urlsafe(9), pid=p['id'], name=p['name'], kind=kind,
                 amount=amount, at=now, by=by, reverses=reverses)
    room['ledger'].append(entry)
    action = {'buyin': '买入', 'buyout': '买出', 'reverse_buyin': '冲正买入'}[kind]
    log(room, f"{p['name']} {action} {amount}", now, 'ledger')
    p['profit'] = p['buyout'] + p['stack'] - p['buyin']


def cashout(room, p, now, by):
    require(not in_hand(room, p['id']), '当前手牌结束后才能离座')
    held = squid.member(room, p['id']) is not None
    if p['stack'] and not held:
        post_ledger(room, p, 'buyout', p['stack'], now, by)
    p.update(seat=None, leave=False, away=False, squid_held=held)
    room['requests'] = [r for r in room['requests'] if r['pid'] != p['id']]
    log(room, f"{p['name']} 离座" + (' · 筹码暂留，本轮鱿鱼收付完成后买出' if held else ''), now, 'room')


def release_squid_balances(room, now):
    for p in room['players'].values():
        if p.get('squid_held') and squid.member(room, p['id']) is None:
            p['squid_held'] = False
            if p['seat'] is None and p['stack']:
                post_ledger(room, p, 'buyout', p['stack'], now, room['owner'])


def apply_squid_config(room, now):
    if (room['hand'] and room['hand']['result'] is None) or room.get('straddle_offer'):
        return
    if not room['settings'].get('squid'):
        cancelled = squid.cancel(room, now, '关闭鱿鱼游戏')
        if cancelled:
            log(room, f"第 {cancelled['number']} 轮鱿鱼已作废 · 关闭玩法", now, 'squid')
    elif room.get('squid_round'):
        room['squid_round']['amount'] = room['settings']['squid_amount']
    release_squid_balances(room, now)


def credit_request(room, req, now, by):
    p = room['players'][req['pid']]
    if req['kind'] == 'seat':
        require(p['seat'] is None and not p['banned'], '无法入座')
        require(not any(x['seat'] == req['seat'] for x in room['players'].values()), '座位已被占用')
        require(not any(x['id'] != p['id'] and x['seat'] is not None and x['name'] == req['name'] for x in room['players'].values()), '该昵称已被使用')
        require(req['amount'] > 0 or (p.get('squid_held') and p['stack'] > 0), '暂留筹码已结算，请重新申请买入')
        p['name'] = req['name']
        p.update(seat=req['seat'], away=False, leave=False, squid_held=False)
        if p['first_seat']:
            p['bank'] = room['settings']['timebank']
            p['first_seat'] = False
        room['requests'] = [x for x in room['requests'] if x['seat'] != req['seat'] or x['kind'] != 'seat']
    else:
        require(p['seat'] is not None and not p['leave'], '玩家已离座或正在离座')
    if req['amount']:
        post_ledger(room, p, 'buyin', req['amount'], now, by)
    else:
        log(room, f"{p['name']} 恢复入座，沿用本轮待结算筹码", now, 'room')
    room['requests'] = [x for x in room['requests'] if x['id'] != req['id']]


def eligible(room, now):
    return sorted([p for p in room['players'].values() if p['seat'] is not None and p['stack'] > 0
                   and not p['away'] and not p['leave'] and not p['banned']
                   and (p['online'] or now - p['offline'] < 300)], key=lambda p: p['seat'])


def next_seat(seats, after):
    return min(seats, key=lambda s: (s - after - 1) % 9)


def positions(room, players):
    seats = [p['seat'] for p in players]
    if room['big_blind'] is None:
        button = seats[0]
        sb = button if len(seats) == 2 else next_seat(seats, button)
        bb = next_seat(seats, sb)
    elif len(seats) == 2:
        bb = next_seat(seats, room['big_blind'])
        button = sb = next(s for s in seats if s != bb)
    else:
        bb = next_seat(seats, room['big_blind'])
        sb = room['big_blind']
        ring = sorted(set(seats + [sb]))
        button = ring[(ring.index(sb) - 1) % len(ring)]
    ordered = sorted(players, key=lambda p: (p['seat'] - button - 1) % 9)
    return dict(button=button, sb=sb, bb=bb, ids=[p['id'] for p in ordered])


def begin_next(room, now):
    apply_squid_config(room, now)
    if now < reveal_deadline(room['hand']):
        room.update(phase='between', deadline=reveal_deadline(room['hand']))
        return
    if room['paused'] or room['recovery'] or not room['started'] or room['closed_at']:
        return
    if room['closing']:
        close_room(room, now)
        return
    players = eligible(room, now)
    if len(players) < 2:
        room.update(phase='waiting', deadline=None)
        return
    pos = positions(room, players)
    room['straddle_offer'] = {**pos, 'pid': None, 'bounty_rule': bounty.rule(room['settings']),
                             'squid_rule': squid.rule(room['settings']),
                             'short_deck': room['settings'].get('short_deck', False)}
    utg_seat = next_seat([p['seat'] for p in players], pos['bb'])
    utg = next(p for p in players if p['seat'] == utg_seat)
    if room['settings']['straddle'] and len(players) >= 3 and utg['online'] and utg['stack'] >= 2 * room['settings']['bb']:
        room['straddle_offer']['pid'] = utg['id']
        room.update(phase='straddle', deadline=now + 5)
    else:
        deal(room, now, False)


def deal(room, now, straddle):
    offer = room['straddle_offer']
    active = {p['id'] for p in eligible(room, now)}
    if any(pid not in active for pid in offer['ids']):
        room.update(phase='waiting', deadline=None, straddle_offer=None)
        begin_next(room, now)
        return
    players = [room['players'][pid] for pid in offer['ids']]
    config = room['settings']
    blinds = [config['sb'] if p['seat'] == offer['sb'] else config['bb'] if p['seat'] == offer['bb'] else 0 for p in players]
    if len(players) == 2:
        blinds = [config['sb'], config['bb']]
    if straddle:
        idx = offer['ids'].index(offer['pid'])
        require(players[idx]['online'] and players[idx]['stack'] >= 2 * config['bb'], '当前无法 Straddle')
        blinds[idx] = 2 * config['bb']
        log(room, f"{players[idx]['name']} Straddle {blinds[idx]}", now)
    room['number'] += 1
    room.update(button=offer['button'], small_blind=offer['sb'], big_blind=offer['bb'])
    room['hand'] = engine.new_hand(offer['ids'], [p['seat'] for p in players],
        [p['stack'] for p in players], blinds, config['bb'], room['number'], offer.get('short_deck', False))
    room['hand']['button'] = offer['button']
    room['hand']['allow_twice'] = config['twice']
    room['hand']['bounty_rule'] = copy.deepcopy(offer.get('bounty_rule', bounty.rule({})))
    squid.begin_hand(room, room['hand'], offer.get('squid_rule', squid.rule({})), now)
    room.update(straddle_offer=None, deadline=None)
    mode = '短牌' if room['hand']['short_deck'] else '普通'
    log(room, f"第 {room['number']} 手开始 · {mode} · 盲注 {config['sb']}/{config['bb']}", now)
    progress_hand(room, engine.state_for(room['hand']), now)


def set_clock(room, state, now):
    hand = room['hand']
    pid = hand['ids'][state.actor_index]
    hand['last_actions'].pop(pid, None)
    hand['action_seq'] += 1
    hand['clock'] = dict(pid=pid, base_until=now + 20, until=now + 20 + room['players'][pid]['bank'],
                         initial=room['players'][pid]['bank'])


def consume_bank(room, now):
    clock = room['hand']['clock'] if room['hand'] else None
    if clock:
        room['players'][clock['pid']]['bank'] = round(max(0, min(clock['initial'], clock['until'] - now)), 2)


def progress_hand(room, state, now):
    hand = room['hand']
    hand.pop('action_display', None)
    old_boards = hand.get('boards', [[]])
    before_burns = tuple(map(repr, state.burn_cards))
    previous_equity = hand.get('runout_equity')
    phase = engine.advance(hand, state, hand['allow_twice'], pause_on_board=True)
    hand['boards'] = engine.boards(state)
    room.update(phase=phase, deadline=None)
    hand['clock'] = None
    hand['deal'] = None
    if phase == 'dealing':
        hand['last_actions'].clear()
        previous = [len(old_boards[i]) if i < len(old_boards) else hand.get('runout_prefix', 0)
                    for i in range(len(hand['boards']))]
        count = sum(len(board) - previous[i] for i, board in enumerate(hand['boards']))
        hand['active_board'] = next((i for i, board in enumerate(hand['boards']) if len(board) > previous[i]), 0)
        start = now
        if hand.get('runout_players'):
            board = hand['active_board']
            started = time.monotonic()
            equity.prepare_deal(hand, board, previous[board], len(hand['boards'][board]),
                                before_burns, tuple(map(repr, state.burn_cards)))
            start += time.monotonic() - started
            if not previous_equity or previous_equity['board'] != board:
                start += .75  # Let players read the initial odds after reveal/switch.
        # Keep the completed flop/turn and its odds visible before the next street.
        # The persisted deadline also governs reconnects; river result timing is separate.
        read_pause = (RUNOUT_STREET_PAUSE if hand.get('runout_players')
                      and len(hand['boards'][hand['active_board']]) < 5 else 0)
        hand['deal'] = dict(seq=len(hand['ops']), start=start, until=start + count * .25 + read_pause,
                            previous=previous)
        room['deadline'] = hand['deal']['until']
    elif phase == 'betting':
        set_clock(room, state, now)
    elif phase == 'runout':
        room['deadline'] = now + 15
        hand['voters'] = [hand['ids'][i] for i in state.runout_count_selector_indices]
        log(room, '等待全部未弃牌玩家选择是否发两次牌', now)
    elif phase == 'finished':
        finish_hand(room, state, now)


def finish_hand(room, state, now):
    hand = room['hand']
    if hand['result'] is not None:
        return
    hand['last_actions'].clear()
    require(sum(state.stacks) == sum(hand['initial']), '牌局筹码不守恒')
    payouts = [0] * len(hand['ids'])
    for award in hand['awards']:
        for i, amount in enumerate(award['amounts']):
            payouts[i] += amount
        details = '、'.join(f"{room['players'][hand['ids'][i]]['name']} +{a}" for i, a in enumerate(award['amounts']) if a)
        suffix = '' if len(hand.get('boards', [])) <= 1 or award['board'] is None else f" · 第 {award['board'] + 1} 组"
        log(room, f"{'主池' if award['pot'] == 0 else '边池 ' + str(award['pot'])}{suffix}：{details}", now)
    # PokerKit may use board=None after killing losing hands, even at showdown.
    # Preserve its showdown order before that cleanup, then reveal through the
    # last winner across every pot. All-in reveals remain public independently.
    order = hand.get('showdown_order', [])
    winners = {pid for pid, won in zip(hand['ids'], payouts) if won}
    winners.update(hand['ids'][i] for award in hand['awards'] for i in award.get('winners', []))
    last_winner = max((i for i, pid in enumerate(order) if pid in winners), default=-1)
    hand['revealed'] = list(dict.fromkeys(hand['revealed'] + order[:last_winner + 1]))
    hand['folded'] = engine.folded_players(hand, state)
    stacks = list(state.stacks)
    captured = settlement.accounts(room, hand, state, payouts)
    hand['bounty'] = bounty.settle(room, hand, stacks, now)
    require(sum(stacks) == sum(hand['initial']) and min(stacks) >= 0, '奖励结算筹码不守恒')
    if hand['bounty'] is not None:
        reward = hand['bounty']
        log(room, f"{reward['name']} 获得2-7奖励 +{reward['total']} · " +
            '、'.join(f"{p['name']} 支付 {p['amount']}" for p in reward['payments']), now)
    for i, pid in enumerate(hand['ids']):
        room['players'][pid]['stack'] = stacks[i]
    hand['squid'] = squid.finish_hand(room, hand, now)
    for player in room['players'].values():
        player['profit'] = player['buyout'] + player['stack'] - player['buyin']
    stacks = [room['players'][pid]['stack'] for pid in hand['ids']]
    if hand['squid']:
        event = hand['squid']
        award = event['award']
        log(room, f"{award['name']} 获得鱿鱼 · 本轮 {award['count']} 个 · 已发 {award['issued']}/{award['total']}", now, 'squid')
        if event['settlement']:
            log(room, f"第 {award['round']} 轮鱿鱼结算 · " + '、'.join(
                f"{r['name']} {r['delta']:+d}" for r in event['settlement']['results']), now, 'squid')
    result = []
    for i, pid in enumerate(hand['ids']):
        p = room['players'][pid]
        p['stack'] = stacks[i]
        p['profit'] = p['buyout'] + p['stack'] - p['buyin']
        p['hands'] += 1
        if p['hands'] % room['settings']['refill'] == 0:
            p['bank'] = room['settings']['timebank']
        result.append(dict(pid=pid, name=p['name'], delta=stacks[i] - hand['initial'][i], won=payouts[i]))
    hand['result'] = result
    hand['showdown_results'] = hands.showdown_results(hand)
    hand['finished_at'] = now
    if hand.get('presentation_version'):
        hand['presentation'] = settlement.timeline(hand, captured, now)
    hand['reveal_start'] = hand.get('presentation', {}).get('until', now)
    hand['reveal_until'] = hand['reveal_start'] + 5
    if not hand['awards']:
        hand['uncontested_winner'] = achievements.zero_pot_winner(hand)
        log(room, f"{room['players'][hand['uncontested_winner']]['name']} 获胜 · 无人形成底池，投入已退回", now)
    achievements.retry_pending(room)
    achievements.record(room, hand)
    room['history'].append(copy.deepcopy(hand))
    apply_squid_config(room, now)
    for p in room['players'].values():
        if p['leave']:
            cashout(room, p, now, room['owner'])
    for req in list(room['requests']):
        if req.get('approved') and room['players'][req['pid']]['seat'] is not None:
            credit_request(room, req, now, req['by'])
    room['rebuy'] = [p['id'] for p in room['players'].values() if p['seat'] is not None and p['stack'] == 0]
    room.update(phase='rebuy' if room['rebuy'] else 'between', deadline=hand['reveal_start'] + (20 if room['rebuy'] else 5))
    if room['closing']:
        close_room(room, now)


def close_room(room, now):
    if room['hand'] and room['hand']['result'] is None:
        return
    if now < reveal_deadline(room['hand']):
        return
    cancelled = squid.cancel(room, now, '房间结束')
    if cancelled:
        log(room, f"第 {cancelled['number']} 轮鱿鱼已作废 · 房间结束", now, 'squid')
    release_squid_balances(room, now)
    for p in room['players'].values():
        if p['seat'] is not None:
            cashout(room, p, now, room['owner'])
    room.update(phase='closed', closed_at=now, deadline=None, requests=[], straddle_offer=None)
    log(room, '房间已结束，全部筹码已结算', now, 'room')


def betting_step(hand, state, name, *args):
    # PokerKit collects bets and returns uncalled chips within the final action.
    # Capture the submitted action before those automatic presentation changes.
    actor = state.actor_index
    display = dict(bets=list(state.bets), stacks=list(state.stacks))
    amount = (state.checking_or_calling_amount if name == 'check_or_call' else
              args[0] - state.bets[actor] if name == 'complete_bet_or_raise_to' else 0)
    display['pot'] = state.total_pot_amount + amount
    engine.step(hand, state, name, *args)
    display['bets'][actor] += amount
    display['stacks'][actor] -= amount
    return display


def progress_action(room, state, display, now):
    hand = room['hand']
    if state.actor_index is not None:
        progress_hand(room, state, now)
        return
    if hand['allow_twice'] and hand['runouts'] is None and list(state.runout_count_selector_indices):
        progress_hand(room, state, now)
    else:
        room.update(phase='action_hold', deadline=now + LAST_ACTION_PAUSE)
        hand.update(clock=None, deal=None)
    hand['action_display'] = display


def act(room, pid, data, now):
    hand = room['hand']
    require(room['phase'] == 'betting' and not room['recovery'], '当前不能进行下注操作')
    require(data.get('hand') == hand['number'] and data.get('seq') == hand['action_seq'], '行动已过期，请按当前牌局操作')
    require(hand['clock']['pid'] == pid, '尚未轮到你行动')
    if now >= hand['clock']['until']:
        raise GameError('行动已超时')
    state = engine.state_for(hand)
    actor_index = state.actor_index
    kind = data.get('action')
    if kind == 'fold':
        require(state.can_fold(), '当前不能弃牌')
        display = betting_step(hand, state, 'fold')
        label = '弃牌'
        table_label = '弃牌'
    elif kind == 'call':
        amount = state.checking_or_calling_amount
        display = betting_step(hand, state, 'check_or_call')
        label = f'跟注 {amount}' if amount else '过牌'
        table_label = '跟注' if amount else '过牌'
    elif kind == 'raise':
        amount = integer(data.get('amount'), 1)
        require(state.can_complete_bet_or_raise_to(amount), '加注金额或加注权不合法')
        table_label = '加注' if max(state.bets) else '下注'
        display = betting_step(hand, state, 'complete_bet_or_raise_to', amount)
        label = f'下注 / 加注到 {amount}'
    else:
        raise GameError('未知行动')
    consume_bank(room, now)
    hand['last_actions'][pid] = '全下' if kind != 'fold' and display['stacks'][actor_index] == 0 else table_label
    log(room, f"{room['players'][pid]['name']} {label}", now)
    progress_action(room, state, display, now)


def command(room, pid, data, now):
    p = room['players'][pid]
    kind = data.get('type')
    require(not room['closed_at'], '房间已结束')
    if kind in {'start', 'pause', 'resume', 'end', 'approve', 'reject', 'settings', 'kick', 'transfer', 'credit', 'reverse'}:
        require(pid == room['owner'], '此操作需要房主权限')
    if kind == 'request_seat':
        require(not room['closing'] and p['seat'] is None and not p['banned'], '当前不能申请入座')
        seat = integer(data.get('seat'), 0, 8)
        require(not any(x['seat'] == seat for x in room['players'].values()), '座位已被占用')
        name = clean_name(data.get('name', ''))
        require(not any(x['id'] != pid and x['name'] == name and x['seat'] is not None for x in room['players'].values()), '该昵称已被使用')
        req = dict(id=secrets.token_urlsafe(9), kind='seat', pid=pid, name=name, seat=seat,
                   amount=integer(data.get('amount'), 0 if p.get('squid_held') and p['stack'] > 0 else 1), approved=False, at=now)
        room['requests'] = [x for x in room['requests'] if x['pid'] != pid]
        room['requests'].append(req)
        p['name'] = name
        log(room, f'{name} 申请入座 {seat + 1} 号位，买入 {req["amount"]}', now, 'room')
        if pid == room['owner']:
            credit_request(room, req, now, pid)
    elif kind == 'topup':
        require(not room['closing'] and p['seat'] is not None and not p['leave'], '当前不能补码')
        require(not any(x['pid'] == pid for x in room['requests']), '已有待处理申请')
        req = dict(id=secrets.token_urlsafe(9), kind='topup', pid=pid, name=p['name'], seat=p['seat'],
                   amount=integer(data.get('amount'), 1), approved=False, at=now)
        room['requests'].append(req)
        log(room, f'{p["name"]} 申请补码 {req["amount"]}', now, 'room')
        if pid == room['owner']:
            if in_hand(room, pid):
                req.update(approved=True, by=pid)
            else:
                credit_request(room, req, now, pid)
    elif kind in {'approve', 'reject', 'cancel_request'}:
        req = next((x for x in room['requests'] if x['id'] == data.get('request')), None)
        require(req is not None, '申请已处理或已过期')
        require(not req['approved'], '已批准的补码正在等待本手结束')
        if kind == 'cancel_request':
            require(req['pid'] == pid, '只能取消自己的申请')
        if kind == 'approve':
            require(not room['closing'], '房间正在结束')
            log(room, f"房主批准 {req['name']} 的{'入座' if req['kind'] == 'seat' else '补码'}申请", now, 'room')
            if req['kind'] == 'topup' and in_hand(room, req['pid']):
                req.update(approved=True, by=pid)
            else:
                credit_request(room, req, now, pid)
        else:
            room['requests'].remove(req)
            log(room, f"{req['name']} 的申请已{'取消' if kind == 'cancel_request' else '拒绝'}", now, 'room')
    elif kind in {'leave', 'kick'}:
        target = p if kind == 'leave' else room['players'].get(data.get('pid'))
        require(target is not None and target['seat'] is not None, '玩家未入座')
        if kind == 'kick':
            require(target['id'] != pid, '不能踢出自己')
            log(room, f"房主移除 {target['name']}", now, 'room')
        if in_hand(room, target['id']):
            target['leave'] = True
            log(room, f"{target['name']} 将在本手结束后离座", now, 'room')
        else:
            cashout(room, target, now, pid)
    elif kind == 'away':
        require(p['seat'] is not None, '请先入座')
        require(type(data.get('value')) is bool, '状态无效')
        require(data['value'] or p['stack'] > 0, '请先完成重买入')
        p['away'] = data['value']
        log(room, f"{p['name']} {'离开' if p['away'] else '回到游戏'}", now, 'room')
    elif kind == 'start':
        require(not room['started'] and len(eligible(room, now)) >= 2, '至少需要两位可参与玩家')
        room.update(started=True, paused=False)
        begin_next(room, now)
    elif kind == 'pause':
        room['paused'] = True
        log(room, '房主暂停后续发牌', now, 'room')
    elif kind in {'resume', 'end'}:
        if kind == 'end':
            room['closing'] = True
            room['requests'] = [r for r in room['requests'] if r.get('approved')]
            log(room, '房主请求结束房间', now, 'room')
        room['paused'] = False
        if room['recovery']:
            room['recovery'] = False
            room['phase'] = room.pop('resume_phase', None) or 'waiting'
            if room['phase'] == 'betting':
                set_clock(room, engine.state_for(room['hand']), now)
            elif room['phase'] == 'dealing':
                complete_deal(room, now)
            elif room['phase'] == 'action_hold' and now >= room['deadline']:
                progress_hand(room, engine.state_for(room['hand']), now)
            elif room['phase'] == 'runout':
                room['deadline'] = now + 15
            elif room['phase'] == 'straddle':
                room['deadline'] = now + 5
            elif room['phase'] in {'rebuy', 'between'}:
                room['deadline'] = now + (room.get('remaining') or 0)
        if kind == 'end' and not (room['hand'] and room['hand']['result'] is None):
            close_room(room, now)
        elif room['phase'] == 'waiting':
            begin_next(room, now)
    elif kind == 'settings':
        require(not room['closing'], '房间正在结束')
        patch = data.get('settings')
        require(isinstance(patch, dict), '房间配置格式不正确')
        playing = bool(room['hand'] and room['hand']['result'] is None) or room['phase'] == 'straddle'
        if playing:
            require(set(patch) <= {'bounty', 'bounty_amount', 'squid', 'squid_amount', 'squid_reveal', 'short_deck'},
                    '本手进行中只能调整短牌、2-7奖励和鱿鱼规则，其他配置请在两手之间修改')
        updated = settings({**room['settings'], **patch})
        old_short_deck = room['settings'].get('short_deck', False)
        old_squid = squid.rule(room['settings'])
        old_rule = bounty.rule(room['settings'])
        room['settings'] = updated
        for player in room['players'].values():
            player['bank'] = min(player['bank'], updated['timebank'])
        log(room, '房主更新房间配置', now, 'room')
        if old_short_deck != updated['short_deck']:
            mode = '短牌' if updated['short_deck'] else '普通'
            log(room, f'牌局模式改为{mode} · 下一手生效', now, 'room')
        if old_rule != bounty.rule(updated):
            state_text = f"开启 · 每人 {updated['bounty_amount']}" if updated['bounty'] else '关闭'
            log(room, f'2-7奖励 {state_text} · 下一手生效', now, 'room')
        if old_squid != squid.rule(updated):
            state_text = f"开启 · 单价 {updated['squid_amount']} · {'自动亮牌' if updated['squid_reveal'] else '不额外亮牌'}" if updated['squid'] else '关闭'
            log(room, f"鱿鱼游戏 {state_text} · {'下一手生效' if playing else '已生效'}", now, 'squid')
        apply_squid_config(room, now)
    elif kind == 'transfer':
        target = room['players'].get(data.get('pid'))
        require(target and target['online'] and not target['banned'] and target['id'] != pid, '请选择其他在线参与者')
        room['owner'] = target['id']
        log(room, f"房主已转让给 {target['name']}", now, 'room')
    elif kind == 'credit':
        require(not room['closing'], '房间正在结束')
        target = room['players'].get(data.get('pid'))
        require(target and target['seat'] is not None and not target['leave'], '玩家未入座')
        require(not in_hand(room, target['id']), '请在当前手牌结束后记入买入')
        post_ledger(room, target, 'buyin', integer(data.get('amount'), 1), now, pid)
    elif kind == 'reverse':
        entry = next((x for x in room['ledger'] if x['id'] == data.get('entry')), None)
        require(entry and entry['kind'] == 'buyin', '只能冲正买入记录')
        require(not any(x['reverses'] == entry['id'] for x in room['ledger']), '此记录已冲正')
        target = room['players'][entry['pid']]
        require(squid.member(room, target['id']) is None, '本轮鱿鱼尚未结算，不能冲正买入')
        require(target['seat'] is not None and target['stack'] == entry['amount'], '仅支持冲正尚未使用的全额买入；不允许部分买出')
        require(not any(h['finished_at'] > entry['at'] and target['id'] in h['ids'] for h in room['history']), '该买入已参与手牌，不能冲正')
        post_ledger(room, target, 'reverse_buyin', entry['amount'], now, pid, entry['id'])
        cashout(room, target, now, pid)
    elif kind == 'straddle':
        require(room['phase'] == 'straddle' and not room['recovery'], 'Straddle 选择已结束')
        require(room['straddle_offer']['pid'] == pid, '仅本手 UTG 可以选择')
        require(type(data.get('value')) is bool, '选择无效')
        require(now < room['deadline'], 'Straddle 选择已超时')
        deal(room, now, data['value'])
    elif kind == 'vote':
        require(room['phase'] == 'runout' and not room['recovery'], '发牌次数选择已结束')
        hand = room['hand']
        require(pid in hand['voters'] and pid not in hand['votes'], '不能重复或代替他人选择')
        require(type(data.get('value')) is bool and now < room['deadline'], '选择无效或已超时')
        hand['votes'][pid] = data['value']
        log(room, f"{p['name']} {'同意' if data['value'] else '不同意'}发两次牌", now)
        if len(hand['votes']) == len(hand['voters']):
            resolve_runout(room, now)
    elif kind == 'act':
        act(room, pid, data, now)
    elif kind == 'show_cards':
        hand = room['hand']
        require(hand and hand['result'] is not None and pid in hand['dealt'], '当前没有可展示的底牌')
        require(data.get('hand') == hand['number'], '亮牌请求已过期')
        require(now >= hand.get('reveal_start', 0), '派彩完成后可以亮牌')
        require(now < reveal_deadline(hand), '亮牌时间已结束')
        indices = data.get('cards')
        require(isinstance(indices, list) and 1 <= len(indices) <= 2, '请选择要亮出的底牌')
        require(all(type(i) is int and i in (0, 1) for i in indices) and len(set(indices)) == len(indices), '底牌选择无效')
        previous = set(shown_indices(hand, pid))
        added = sorted(set(indices) - previous)
        if added:
            hand.setdefault('shown_cards', {})[pid] = sorted(previous | set(indices))
            if len(hand['shown_cards'][pid]) == 2:
                hand['revealed'].append(pid)
            history = next(h for h in reversed(room['history']) if h['number'] == hand['number'])
            history['shown_cards'] = copy.deepcopy(hand['shown_cards'])
            history['revealed'] = hand['revealed'][:]
            log(room, f"{p['name']} 亮出底牌 {' '.join(hand['dealt'][pid][i] for i in added)}", now)
    else:
        raise GameError('未知操作')
    if room['phase'] == 'waiting' and room['started']:
        begin_next(room, now)
    if room['phase'] == 'rebuy' and not rebuy_pending(room):
        room.update(phase='between', deadline=now)
        begin_next(room, now)


def rebuy_pending(room):
    return [pid for pid in room['rebuy'] if room['players'][pid]['seat'] is not None and room['players'][pid]['stack'] == 0]


def resolve_runout(room, now):
    hand = room['hand']
    hand['runouts'] = 2 if all(hand['votes'].get(pid) is True for pid in hand['voters']) else 1
    log(room, f"本手发 {hand['runouts']} 次牌", now)
    progress_hand(room, engine.state_for(hand), now)


def tick(room, now):
    if room['closed_at']:
        return
    for p in room['players'].values():
        if not p['online'] and p['seat'] is not None and not p['away'] and now - p['offline'] >= 300:
            p['away'] = True
            log(room, f"{p['name']} 离线满 5 分钟，进入离开状态", now, 'room')
    if room['empty_since'] is not None and now - room['empty_since'] >= 86400:
        room['closing'] = True
        room['paused'] = False
        if room['recovery']:
            room['recovery'] = False
            room['phase'] = room.get('resume_phase') or 'waiting'
    if room['recovery']:
        return
    if room['phase'] == 'action_hold' and now >= room['deadline']:
        progress_hand(room, engine.state_for(room['hand']), now)
    elif room['phase'] == 'dealing' and now >= room['deadline']:
        complete_deal(room, now)
    elif room['phase'] == 'betting':
        hand = room['hand']
        consume_bank(room, now)
        if now >= hand['clock']['until']:
            state = engine.state_for(hand)
            pid = hand['clock']['pid']
            check = state.checking_or_calling_amount == 0
            display = betting_step(hand, state, 'check_or_call' if check else 'fold')
            hand['last_actions'][pid] = '过牌' if check else '弃牌'
            log(room, f"{room['players'][pid]['name']} 超时{'过牌' if check else '弃牌'}", now)
            progress_action(room, state, display, now)
    elif room['phase'] == 'runout' and now >= room['deadline']:
        resolve_runout(room, now)
    elif room['phase'] == 'straddle':
        offer = room['straddle_offer']
        if now >= room['deadline'] or not room['players'][offer['pid']]['online']:
            deal(room, now, False)
    elif room['phase'] == 'rebuy':
        pending = rebuy_pending(room)
        if not pending or now >= room['deadline']:
            for pid in pending:
                cashout(room, room['players'][pid], now, room['owner'])
            room.update(phase='between', deadline=now)
            begin_next(room, now)
    elif room['phase'] == 'between' and now >= room['deadline']:
        begin_next(room, now)
    elif room['phase'] == 'waiting':
        begin_next(room, now)
    if room['closing']:
        close_room(room, now)


def complete_deal(room, now):
    hand = room['hand']
    if (hand.get('presentation_version') and hand.get('runouts') == 2
            and hand.get('active_board', 0) == 0 and len(hand.get('boards', [[]])[0]) == 5
            and not hand.get('first_runout_shown')):
        hand['runout_result'] = hands.runout_results(hand, engine.state_for(hand))
        hand['first_runout_shown'] = True
        hand['deal'] = None
        room['deadline'] = now + 1.5
        return
    hand.pop('runout_result', None)
    log(room, '公共牌 ' + ' / '.join(' '.join(b) for b in hand['boards']), now)
    progress_hand(room, engine.state_for(hand), now)


def reveal_deadline(hand):
    return hand.get('reveal_until', 0) if hand and hand['result'] is not None else 0


def shown_indices(hand, pid):
    return [0, 1] if pid in hand['revealed'] else hand.get('shown_cards', {}).get(pid, [])


def visible_cards(hand, pid, viewer):
    cards = hand['dealt'].get(pid, [])
    if pid == viewer:
        return cards[:]
    shown = shown_indices(hand, pid)
    return [card if i in shown else None for i, card in enumerate(cards)] if shown else []


def migrate_reveals(room):
    changed = False
    for hand in [room['hand'], *room['history']]:
        if not hand or hand.get('reveal_version') or hand['result'] is None:
            continue
        # Old engine operations showed all contenders internally. Only the
        # winners were public under the old rules; never expose the old losers.
        if any(name == 'show_or_muck_hole_cards' for name, _ in hand['ops']):
            winners = [r['pid'] for r in hand['result'] if r['won'] > 0]
            hand['revealed'] = list(dict.fromkeys(hand['revealed'] + winners))
        hand.update(reveal_version=1, shown_cards={}, reveal_until=hand['finished_at'] + 5)
        changed = True
    for hand in [room['hand'], *room['history']]:
        if hand and hand['result'] is not None and 'folded' not in hand:
            hand['folded'] = engine.folded_players(hand)
            changed = True
        if hand and hand['result'] is not None and 'showdown_results' not in hand:
            hand['showdown_results'] = hands.showdown_results(hand)
            changed = True
    return changed


def public_hand(hand, viewer, include_hint=False):
    if not hand:
        return None
    return dict(number=hand['number'], short_deck=hand.get('short_deck', False), ids=hand['ids'], seats=hand['seats'], button=hand.get('button'),
        boards=hand.get('boards', [[]]), cards={pid: visible_cards(hand, pid, viewer) for pid in hand['dealt']
        if pid == viewer or shown_indices(hand, pid)}, revealed=hand['revealed'],
        shown_cards={pid: shown_indices(hand, pid) for pid in hand['dealt'] if shown_indices(hand, pid)},
        reveal_until=reveal_deadline(hand), reveal_start=hand.get('reveal_start', 0), deal=hand.get('deal'),
        active_board=hand.get('active_board', 0), runout_result=copy.deepcopy(hand.get('runout_result', [])),
        runout_equity=copy.deepcopy(hand.get('runout_equity')) if include_hint and hand['result'] is None
            and hand.get('deal') and not hand.get('runout_result') else None,
        presentation=copy.deepcopy(hand.get('presentation')) if include_hint else None,
        showdown_results=hand.get('showdown_results', []),
        pots=copy.deepcopy(hand.get('pots', [])),
        uncontested_winner=hand.get('uncontested_winner'),
        bounty_rule=copy.deepcopy(hand.get('bounty_rule', bounty.rule({}))),
        bounty=copy.deepcopy(hand.get('bounty')) if hand['result'] is not None else None,
        squid_rule=copy.deepcopy(hand.get('squid_rule', squid.rule({}))),
        squid=copy.deepcopy(hand.get('squid')) if hand['result'] is not None else None,
        public_hand_labels=hands.public_labels(hand),
        **({'own_hand_labels': hands.own_labels(hand, viewer)} if include_hint else {}),
        result=hand['result'], awards=hand['awards'], votes=hand['votes'], voters=hand.get('voters', []),
        runouts=hand['runouts'], seq=hand['action_seq'], clock=hand['clock'], last_actions=hand['last_actions'])


def view(room, viewer, now):
    hand = room['hand']
    state = engine.state_for(hand) if hand and hand['result'] is None else None
    players = []
    for p in room['players'].values():
        visible = {k: p[k] for k in ('id', 'name', 'seat', 'stack', 'buyin', 'buyout', 'profit', 'away',
                                     'online', 'offline', 'bank', 'hands', 'leave', 'banned', 'achievements')}
        membership = squid.member(room, p['id'])
        visible.update(bet=0, folded=False, cards=[], holding=p['stack'],
                       squid_count=membership['count'] if membership else None, squid_held=p.get('squid_held', False))
        visible['achievements'] = p['achievements'].copy()
        if state and p['id'] in hand['ids']:
            idx = hand['ids'].index(p['id'])
            visible.update(stack=state.stacks[idx], bet=state.bets[idx], folded=not state.statuses[idx])
            if display := hand.get('action_display'):
                visible.update(stack=display['stacks'][idx], bet=display['bets'][idx])
        if hand:
            visible['cards'] = visible_cards(hand, p['id'], viewer)
            if hand['result'] is not None:
                visible['folded'] = p['id'] in hand['folded']
        players.append(visible)
    result = {k: copy.deepcopy(room[k]) for k in ('id', 'name', 'settings', 'owner', 'phase', 'deadline',
              'button', 'small_blind', 'big_blind', 'number', 'started', 'paused', 'recovery', 'closing', 'closed_at', 'version')}
    result.update(me=viewer, players=players, achievement_since=room['achievement_since'].copy(),
        short_deck_current=(room['straddle_offer'].get('short_deck', False) if room.get('straddle_offer')
                            else hand.get('short_deck', False) if hand else room['settings'].get('short_deck', False)),
        squid_round=copy.deepcopy(room.get('squid_round')),
        squid_history=copy.deepcopy(room.get('squid_history', [])[-100:]),
        squid_current=copy.deepcopy((room.get('straddle_offer') or {}).get('squid_rule', squid.rule({})))
            if room.get('straddle_offer') else
            copy.deepcopy(hand.get('squid_rule', squid.rule({}))) if state else squid.rule(room['settings']),
        bounty_current=copy.deepcopy((room.get('straddle_offer') or {}).get('bounty_rule', bounty.rule({})))
            if room['phase'] == 'straddle' else
            copy.deepcopy(hand.get('bounty_rule', bounty.rule({}))) if state else bounty.rule(room['settings']),
        achievement_pending={metric: len(numbers) for metric, numbers in room.get('achievement_pending', {}).items()},
        hand=public_hand(hand, viewer, include_hint=True), server_time=now,
        requests=[r for r in room['requests'] if viewer == room['owner'] or r['pid'] == viewer],
        logs=room['logs'][-500:], ledger=room['ledger'], history=[public_hand(h, viewer) for h in room['history'][-100:]],
        rebuy=rebuy_pending(room), straddle=room['straddle_offer']['pid'] if room['straddle_offer'] else None,
        pot=hand.get('action_display', {}).get('pot', state.total_pot_amount) if state else 0,
        pots=list(state.pot_amounts) if state else [],
        legal=engine.legal(state) if room['phase'] == 'betting' and state and state.actor_index is not None and hand['ids'][state.actor_index] == viewer else None)
    if viewer in room['players']:
        result['recovery_code'] = room['players'][viewer]['code']
    return result
