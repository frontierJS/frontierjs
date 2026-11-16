// web/src/lib/emoji.js -- the emoji a reaction can be.
//
// The server names a reaction by a short name (`+1`, `heart`), never a glyph, and the
// rows carry only the name. A fixed table is the whole vocabulary this screen offers:
// a name a teammate reacted with elsewhere that is not here draws as `:name:` text,
// so it is still seen and still countable, and nothing is guessed at.

export const EMOJI = {
  '+1': '👍', '-1': '👎', heart: '❤️', smile: '😄', smiley: '😃', grinning: '😀', laughing: '😆',
  joy: '😂', wink: '😉', blush: '😊', slightly_smiling_face: '🙂', neutral_face: '😐',
  thinking: '🤔', thinking_face: '🤔', raised_eyebrow: '🤨', sweat_smile: '😅', sob: '😭', cry: '😢',
  angry: '😠', scream: '😱', sunglasses: '😎', heart_eyes: '😍', star_struck: '🤩', partying_face: '🥳',
  tada: '🎉', confetti_ball: '🎊', clap: '👏', pray: '🙏', raised_hands: '🙌', ok_hand: '👌',
  muscle: '💪', wave: '👋', point_up: '☝️', eyes: '👀', fire: '🔥', rocket: '🚀', sparkles: '✨',
  star: '⭐', boom: '💥', zap: '⚡', bulb: '💡', white_check_mark: '✅', heavy_check_mark: '✔️',
  x: '❌', warning: '⚠️', question: '❓', exclamation: '❗', hourglass: '⌛', clock1: '🕐',
  100: '💯', trophy: '🏆', gift: '🎁', coffee: '☕', pizza: '🍕', beer: '🍺', bug: '🐛',
  memo: '📝', pushpin: '📌', link: '🔗', lock: '🔒', see_no_evil: '🙈', skull: '💀', ghost: '👻',
}

/** The six a post offers without opening the grid. */
export const QUICK = ['+1', 'heart', 'tada', 'laughing', 'eyes', 'white_check_mark']

/** The glyph for a name, or `:name:` when the table does not know it. */
export const glyphOf = (name) => EMOJI[name] ?? `:${name}:`
