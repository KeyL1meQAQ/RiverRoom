import copy
import secrets
import time

from . import engine, hands

MAX_INTEGER = 9_007_199_254_740_991
DEFAULTS = dict(sb=1, bb=2, timebank=10, refill=20, straddle=False, twice=False)


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
    return result


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
             banned=False, seen=[], last_seen=now)
    room['players'][pid] = p
    return p


def create_room(name, config, browser, now=None):
    now = now or time.time()
    room = dict(id=secrets.token_urlsafe(9), name=clean_name(name, '好友牌桌'), settings=settings(config),
                players={}, owner=None, requests=[], ledger=[], logs=[], history=[], hand=None,
                phase='waiting', deadline=None, straddle_offer=None, rebuy=[], button=None,
                small_blind=None, big_blind=None, number=0, started=False, paused=False,
                recovery=False, resume_phase=None, closing=False, closed_at=None,
                empty_since=now, created=now, version=0)
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
    if p['stack']:
        post_ledger(room, p, 'buyout', p['stack'], now, by)
    p.update(seat=None, leave=False, away=False)
    room['requests'] = [r for r in room['requests'] if r['pid'] != p['id']]
    log(room, f"{p['name']} 离座", now, 'room')


def credit_request(room, req, now, by):
    p = room['players'][req['pid']]
    if req['kind'] == 'seat':
        require(p['seat'] is None and not p['banned'], '无法入座')
        require(not any(x['seat'] == req['seat'] for x in room['players'].values()), '座位已被占用')
        require(not any(x['id'] != p['id'] and x['seat'] is not None and x['name'] == req['name'] for x in room['players'].values()), '该昵称已被使用')
        p['name'] = req['name']
        p.update(seat=req['seat'], away=False, leave=False)
        if p['first_seat']:
            p['bank'] = room['settings']['timebank']
            p['first_seat'] = False
        room['requests'] = [x for x in room['requests'] if x['seat'] != req['seat'] or x['kind'] != 'seat']
    else:
        require(p['seat'] is not None and not p['leave'], '玩家已离座或正在离座')
    post_ledger(room, p, 'buyin', req['amount'], now, by)
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
    room['straddle_offer'] = {**pos, 'pid': None}
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
        [p['stack'] for p in players], blinds, config['bb'], room['number'])
    room['hand']['button'] = offer['button']
    room['hand']['allow_twice'] = config['twice']
    room.update(straddle_offer=None, deadline=None)
    log(room, f"第 {room['number']} 手开始 · 盲注 {config['sb']}/{config['bb']}", now)
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
    old_boards = hand.get('boards', [[]])
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
        hand['deal'] = dict(seq=len(hand['ops']), start=now, until=now + count * .25,
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
    hand['last_actions'].clear()
    require(sum(state.stacks) == sum(hand['initial']), '牌局筹码不守恒')
    payouts = [0] * len(hand['ids'])
    for award in hand['awards']:
        for i, amount in enumerate(award['amounts']):
            payouts[i] += amount
        details = '、'.join(f"{room['players'][hand['ids'][i]]['name']} +{a}" for i, a in enumerate(award['amounts']) if a)
        suffix = '' if award['board'] is None else f" · 第 {award['board'] + 1} 次"
        log(room, f"{'主池' if award['pot'] == 0 else '边池 ' + str(award['pot'])}{suffix}：{details}", now)
    # PokerKit may use board=None after killing losing hands, even at showdown.
    # Preserve its showdown order before that cleanup, then reveal through the
    # last winner across every pot. All-in reveals remain public independently.
    order = hand.get('showdown_order', [])
    winners = {pid for pid, won in zip(hand['ids'], payouts) if won}
    winners.update(hand['ids'][i] for award in hand['awards'] for i in award.get('winners', []))
    last_winner = max((i for i, pid in enumerate(order) if pid in winners), default=-1)
    hand['revealed'] = list(dict.fromkeys(hand['revealed'] + order[:last_winner + 1]))
    result = []
    for i, pid in enumerate(hand['ids']):
        p = room['players'][pid]
        p['stack'] = state.stacks[i]
        p['profit'] = p['buyout'] + p['stack'] - p['buyin']
        p['hands'] += 1
        if p['hands'] % room['settings']['refill'] == 0:
            p['bank'] = room['settings']['timebank']
        result.append(dict(pid=pid, name=p['name'], delta=state.stacks[i] - hand['initial'][i], won=payouts[i]))
    hand['result'] = result
    hand['folded'] = engine.folded_players(hand, state)
    hand['showdown_results'] = hands.showdown_results(hand)
    hand['finished_at'] = now
    hand['reveal_until'] = now + 5
    room['history'].append(copy.deepcopy(hand))
    for p in room['players'].values():
        if p['leave']:
            cashout(room, p, now, room['owner'])
    for req in list(room['requests']):
        if req.get('approved') and room['players'][req['pid']]['seat'] is not None:
            credit_request(room, req, now, req['by'])
    room['rebuy'] = [p['id'] for p in room['players'].values() if p['seat'] is not None and p['stack'] == 0]
    room.update(phase='rebuy' if room['rebuy'] else 'between', deadline=now + (20 if room['rebuy'] else 5))
    if room['closing']:
        close_room(room, now)


def close_room(room, now):
    if room['hand'] and room['hand']['result'] is None:
        return
    if now < reveal_deadline(room['hand']):
        return
    for p in room['players'].values():
        if p['seat'] is not None:
            cashout(room, p, now, room['owner'])
    room.update(phase='closed', closed_at=now, deadline=None, requests=[], straddle_offer=None)
    log(room, '房间已结束，全部筹码已结算', now, 'room')


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
        engine.step(hand, state, 'fold')
        label = '弃牌'
        table_label = '弃牌'
    elif kind == 'call':
        amount = state.checking_or_calling_amount
        engine.step(hand, state, 'check_or_call')
        label = f'跟注 {amount}' if amount else '过牌'
        table_label = '跟注' if amount else '过牌'
    elif kind == 'raise':
        amount = integer(data.get('amount'), 1)
        require(state.can_complete_bet_or_raise_to(amount), '加注金额或加注权不合法')
        table_label = '加注' if max(state.bets) else '下注'
        engine.step(hand, state, 'complete_bet_or_raise_to', amount)
        label = f'下注 / 加注到 {amount}'
    else:
        raise GameError('未知行动')
    consume_bank(room, now)
    hand['last_actions'][pid] = '全下' if kind != 'fold' and state.stacks[actor_index] == 0 else table_label
    log(room, f"{room['players'][pid]['name']} {label}", now)
    progress_hand(room, state, now)


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
                   amount=integer(data.get('amount'), 1), approved=False, at=now)
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
            target['banned'] = True
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
        log(room, f"{p['name']} {'AWAY' if p['away'] else '回到游戏'}", now, 'room')
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
        require(not (room['hand'] and room['hand']['result'] is None) and room['phase'] != 'straddle', '请在两手之间调整配置，可先暂停后续发牌')
        updated = settings(data.get('settings'))
        room['settings'] = updated
        for player in room['players'].values():
            player['bank'] = min(player['bank'], updated['timebank'])
        log(room, '房主更新房间配置', now, 'room')
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
            log(room, f"{p['name']} 离线满 5 分钟，进入 AWAY", now, 'room')
    if room['empty_since'] is not None and now - room['empty_since'] >= 86400:
        room['closing'] = True
        room['paused'] = False
        if room['recovery']:
            room['recovery'] = False
            room['phase'] = room.get('resume_phase') or 'waiting'
    if room['recovery']:
        return
    if room['phase'] == 'dealing' and now >= room['deadline']:
        complete_deal(room, now)
    elif room['phase'] == 'betting':
        hand = room['hand']
        consume_bank(room, now)
        if now >= hand['clock']['until']:
            state = engine.state_for(hand)
            pid = hand['clock']['pid']
            check = state.checking_or_calling_amount == 0
            engine.step(hand, state, 'check_or_call' if check else 'fold')
            hand['last_actions'][pid] = '过牌' if check else '弃牌'
            log(room, f"{room['players'][pid]['name']} 超时{'过牌' if check else '弃牌'}", now)
            progress_hand(room, state, now)
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
    return dict(number=hand['number'], ids=hand['ids'], seats=hand['seats'], button=hand.get('button'),
        boards=hand.get('boards', [[]]), cards={pid: visible_cards(hand, pid, viewer) for pid in hand['dealt']
        if pid == viewer or shown_indices(hand, pid)}, revealed=hand['revealed'],
        shown_cards={pid: shown_indices(hand, pid) for pid in hand['dealt'] if shown_indices(hand, pid)},
        reveal_until=reveal_deadline(hand), deal=hand.get('deal'),
        showdown_results=hand.get('showdown_results', []),
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
                                     'online', 'offline', 'bank', 'hands', 'leave', 'banned')}
        visible.update(bet=0, folded=False, cards=[], holding=p['stack'])
        if state and p['id'] in hand['ids']:
            idx = hand['ids'].index(p['id'])
            visible.update(stack=state.stacks[idx], bet=state.bets[idx], folded=not state.statuses[idx])
        if hand:
            visible['cards'] = visible_cards(hand, p['id'], viewer)
            if hand['result'] is not None:
                visible['folded'] = p['id'] in hand['folded']
        players.append(visible)
    result = {k: copy.deepcopy(room[k]) for k in ('id', 'name', 'settings', 'owner', 'phase', 'deadline',
              'button', 'small_blind', 'big_blind', 'number', 'started', 'paused', 'recovery', 'closing', 'closed_at', 'version')}
    result.update(me=viewer, players=players, hand=public_hand(hand, viewer, include_hint=True), server_time=now,
        requests=[r for r in room['requests'] if viewer == room['owner'] or r['pid'] == viewer],
        logs=room['logs'][-500:], ledger=room['ledger'], history=[public_hand(h, viewer) for h in room['history'][-100:]],
        rebuy=rebuy_pending(room), straddle=room['straddle_offer']['pid'] if room['straddle_offer'] else None,
        pot=state.total_pot_amount if state else 0, pots=list(state.pot_amounts) if state else [],
        legal=engine.legal(state) if room['phase'] == 'betting' and state and state.actor_index is not None and hand['ids'][state.actor_index] == viewer else None)
    if viewer in room['players']:
        result['recovery_code'] = room['players'][viewer]['code']
    return result
