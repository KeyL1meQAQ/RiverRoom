import secrets

from . import game


EMOJI = ('😏', '😂', '🙃', '👀', '👏', '😭', '😎', '🤔', '😅', '🤝', '😱', '🫡')
PHRASES = ('我很抱歉', '打得不错', '漂亮！', '这也敢跟？', '让我想想', '运气真好',
           '稳住', '有点意思', '别着急', '手下留情', '你来试试', '下一手见')
ITEMS = ('tomato', 'egg', 'poop')


def make_event(room, pid, data, now):
    game.require(type(data) is dict, '互动参数无效')
    game.require(not room['closed_at'], '房间已结束')
    game.require(room['players'][pid]['seat'] is not None, '请先入座')
    kind = data.get('type')
    event = {'id': secrets.token_urlsafe(12), 'at': now, 'from': pid}
    if kind == 'bubble':
        preset = data.get('preset')
        game.require(type(preset) is str and
                     (preset in EMOJI or preset in PHRASES), '预设内容无效')
        event.update(kind='bubble', preset=preset)
        return event, 'bubble'
    game.require(kind == 'throw', '互动类型无效')
    target_id = data.get('target')
    game.require(type(target_id) is str, '请选择其他已入座玩家')
    target = room['players'].get(target_id)
    game.require(target is not None and target['seat'] is not None and target['id'] != pid,
                 '请选择其他已入座玩家')
    item = data.get('item')
    game.require(type(item) is str and item in ITEMS, '道具无效')
    count = data.get('count')
    game.require(type(count) is int and count in (1, 10), '投掷数量无效')
    event.update(kind='throw', target=target['id'], item=item, count=count)
    return event, 'burst' if count == 10 else 'single'
