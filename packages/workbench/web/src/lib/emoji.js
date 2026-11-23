// web/src/lib/emoji.js -- the emoji names Messages knows, and the glyph each draws as.
//
// The server names a reaction by a short name (`+1`, `heart`), never a glyph, and a post
// body carries `:speech_balloon:` as text. Two fixed tables are the whole vocabulary:
// `EMOJI` is what the reaction picker and the status dialog offer, `MORE` is only looked
// up. A name in neither draws as `:name:` text, so it is still seen and still countable,
// and nothing is guessed at. The names are Mattermost's (GitHub's, mostly), because that
// is what teammates and n8n type.

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

const MORE = {
  // ─── faces ──────────────────────────────────────────────────────────────
  grin: '😁', rofl: '🤣', rolling_on_the_floor_laughing: '🤣', upside_down_face: '🙃', innocent: '😇',
  relaxed: '☺️', yum: '😋', stuck_out_tongue: '😛', stuck_out_tongue_winking_eye: '😜',
  stuck_out_tongue_closed_eyes: '😝', zany_face: '🤪', kissing: '😗', kissing_heart: '😘',
  hugs: '🤗', hugging_face: '🤗', shushing_face: '🤫', face_with_hand_over_mouth: '🤭',
  money_mouth_face: '🤑', zipper_mouth_face: '🤐', expressionless: '😑', no_mouth: '😶', smirk: '😏',
  unamused: '😒', roll_eyes: '🙄', face_with_rolling_eyes: '🙄', grimacing: '😬', lying_face: '🤥',
  relieved: '😌', pensive: '😔', sleepy: '😪', sleeping: '😴', drooling_face: '🤤', mask: '😷',
  face_with_thermometer: '🤒', nauseated_face: '🤢', sneezing_face: '🤧', hot_face: '🥵',
  cold_face: '🥶', woozy_face: '🥴', dizzy_face: '😵', exploding_head: '🤯', cowboy_hat_face: '🤠',
  nerd_face: '🤓', monocle_face: '🧐', confused: '😕', worried: '😟', slightly_frowning_face: '🙁',
  frowning_face: '☹️', open_mouth: '😮', hushed: '😯', astonished: '😲', flushed: '😳',
  pleading_face: '🥺', face_holding_back_tears: '🥹', frowning: '😦', anguished: '😧', fearful: '😨',
  cold_sweat: '😰', disappointed_relieved: '😥', disappointed: '😞', sweat: '😓', persevere: '😣',
  confounded: '😖', weary: '😩', tired_face: '😫', yawning_face: '🥱', triumph: '😤', rage: '😡',
  pout: '😡', cursing_face: '🤬', smiling_imp: '😈', imp: '👿', poop: '💩', hankey: '💩',
  clown_face: '🤡', robot: '🤖', robot_face: '🤖', alien: '👽', saluting_face: '🫡', melting_face: '🫠',

  // ─── hands and people ───────────────────────────────────────────────────
  thumbsup: '👍', thumbsdown: '👎', raised_hand: '✋', hand: '✋', raised_back_of_hand: '🤚',
  vulcan_salute: '🖖', v: '✌️', crossed_fingers: '🤞', metal: '🤘', call_me_hand: '🤙',
  point_left: '👈', point_right: '👉', point_down: '👇', fist: '✊', fist_raised: '✊',
  punch: '👊', facepunch: '👊', open_hands: '👐', palms_up_together: '🤲', handshake: '🤝',
  writing_hand: '✍️', nail_care: '💅', pinched_fingers: '🤌', pinching_hand: '🤏', heart_hands: '🫶',
  brain: '🧠', eye: '👁️', tongue: '👅', lips: '👄', baby: '👶', man: '👨', woman: '👩',
  shrug: '🤷', facepalm: '🤦', face_palm: '🤦', bow: '🙇', raising_hand: '🙋', no_good: '🙅',
  ok_woman: '🙆', information_desk_person: '💁', runner: '🏃', running: '🏃', dancer: '💃',
  man_dancing: '🕺', construction_worker: '👷', cop: '👮', ninja: '🥷', santa: '🎅', zombie: '🧟',
  superhero: '🦸', busts_in_silhouette: '👥', bust_in_silhouette: '👤',

  // ─── hearts ─────────────────────────────────────────────────────────────
  orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚', blue_heart: '💙', purple_heart: '💜',
  black_heart: '🖤', white_heart: '🤍', brown_heart: '🤎', broken_heart: '💔', heartpulse: '💗',
  heartbeat: '💓', two_hearts: '💕', sparkling_heart: '💖', cupid: '💘', gift_heart: '💝',
  revolving_hearts: '💞', heavy_heart_exclamation: '❣️',

  // ─── marks, signs and shapes ────────────────────────────────────────────
  speech_balloon: '💬', thought_balloon: '💭', left_speech_bubble: '🗨️', zzz: '💤', dash: '💨',
  sweat_drops: '💦', droplet: '💧', anger: '💢', dizzy: '💫', collision: '💥',
  heavy_multiplication_x: '✖️', heavy_plus_sign: '➕', heavy_minus_sign: '➖', heavy_division_sign: '➗',
  heavy_dollar_sign: '💲', grey_question: '❔', grey_exclamation: '❕', bangbang: '‼️',
  interrobang: '⁉️', no_entry: '⛔', no_entry_sign: '🚫', stop_sign: '🛑',
  triangular_flag_on_post: '🚩', checkered_flag: '🏁', white_flag: '🏳️', black_flag: '🏴',
  ballot_box_with_check: '☑️', negative_squared_cross_mark: '❎', recycle: '♻️', infinity: '♾️',
  copyright: '©️', registered: '®️', tm: '™️', information_source: 'ℹ️', new: '🆕', free: '🆓',
  up: '🆙', cool: '🆒', ok: '🆗', sos: '🆘', id: '🆔', vs: '🆚', o: '⭕', beginner: '🔰',
  name_badge: '📛', sparkle: '❇️', eight_spoked_asterisk: '✳️', anchor: '⚓', cyclone: '🌀',
  biohazard: '☣️', radioactive: '☢️', peace_symbol: '☮️', yin_yang: '☯️', atom_symbol: '⚛️',
  wheelchair: '♿', no_smoking: '🚭', signal_strength: '📶', high_brightness: '🔆', low_brightness: '🔅',
  red_circle: '🔴', large_blue_circle: '🔵', blue_circle: '🔵', orange_circle: '🟠',
  yellow_circle: '🟡', green_circle: '🟢', large_green_circle: '🟢', purple_circle: '🟣',
  brown_circle: '🟤', black_circle: '⚫', white_circle: '⚪', red_square: '🟥', orange_square: '🟧',
  yellow_square: '🟨', green_square: '🟩', blue_square: '🟦', purple_square: '🟪',
  black_large_square: '⬛', white_large_square: '⬜', small_red_triangle: '🔺',
  small_red_triangle_down: '🔻', large_orange_diamond: '🔶', large_blue_diamond: '🔷',
  small_orange_diamond: '🔸', small_blue_diamond: '🔹', radio_button: '🔘',

  // ─── arrows and keys ────────────────────────────────────────────────────
  arrow_up: '⬆️', arrow_down: '⬇️', arrow_left: '⬅️', arrow_right: '➡️', arrow_upper_right: '↗️',
  arrow_lower_right: '↘️', arrow_upper_left: '↖️', arrow_lower_left: '↙️',
  arrows_counterclockwise: '🔄', arrows_clockwise: '🔃', leftwards_arrow_with_hook: '↩️',
  arrow_right_hook: '↪️', arrow_forward: '▶️', arrow_backward: '◀️', fast_forward: '⏩', rewind: '⏪',
  pause_button: '⏸️', stop_button: '⏹️', record_button: '⏺️', repeat: '🔁',
  twisted_rightwards_arrows: '🔀', hash: '#️⃣', zero: '0️⃣', one: '1️⃣', two: '2️⃣', three: '3️⃣',
  four: '4️⃣', five: '5️⃣', six: '6️⃣', seven: '7️⃣', eight: '8️⃣', nine: '9️⃣', keycap_ten: '🔟',

  // ─── alerts and office ──────────────────────────────────────────────────
  rotating_light: '🚨', bell: '🔔', no_bell: '🔕', loudspeaker: '📢', mega: '📣', mute: '🔇',
  speaker: '🔈', sound: '🔉', loud_sound: '🔊', mag: '🔍', mag_right: '🔎', key: '🔑', old_key: '🗝️',
  unlock: '🔓', closed_lock_with_key: '🔐', lock_with_ink_pen: '🔏', hammer: '🔨', wrench: '🔧',
  nut_and_bolt: '🔩', gear: '⚙️', toolbox: '🧰', hammer_and_wrench: '🛠️', shield: '🛡️', bomb: '💣',
  hocho: '🔪', crystal_ball: '🔮', magnet: '🧲', test_tube: '🧪', microscope: '🔬', telescope: '🔭',
  satellite: '📡', battery: '🔋', electric_plug: '🔌', computer: '💻', desktop_computer: '🖥️',
  keyboard: '⌨️', printer: '🖨️', computer_mouse: '🖱️', floppy_disk: '💾', cd: '💿', dvd: '📀',
  iphone: '📱', calling: '📲', phone: '☎️', telephone: '☎️', telephone_receiver: '📞', pager: '📟',
  fax: '📠', tv: '📺', radio: '📻', camera: '📷', camera_flash: '📸', video_camera: '📹',
  movie_camera: '🎥', film_strip: '🎞️', flashlight: '🔦', candle: '🕯️', money_with_wings: '💸',
  dollar: '💵', euro: '💶', pound: '💷', yen: '💴', moneybag: '💰', credit_card: '💳', gem: '💎',
  chart: '💹', chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', bar_chart: '📊',
  clipboard: '📋', calendar: '📆', date: '📅', spiral_calendar: '🗓️', card_index: '📇',
  file_folder: '📁', open_file_folder: '📂', card_index_dividers: '🗂️', page_facing_up: '📄',
  page_with_curl: '📃', bookmark_tabs: '📑', newspaper: '📰', notebook: '📓', ledger: '📒',
  closed_book: '📕', green_book: '📗', blue_book: '📘', orange_book: '📙', books: '📚', book: '📖',
  open_book: '📖', bookmark: '🔖', label: '🏷️', pencil: '📝', pencil2: '✏️', black_nib: '✒️',
  pen: '🖊️', fountain_pen: '🖋️', paintbrush: '🖌️', crayon: '🖍️', straight_ruler: '📏',
  triangular_ruler: '📐', round_pushpin: '📍', paperclip: '📎', scissors: '✂️', email: '📧',
  envelope: '✉️', incoming_envelope: '📨', envelope_with_arrow: '📩', outbox_tray: '📤',
  inbox_tray: '📥', package: '📦', mailbox: '📫', mailbox_with_mail: '📬', mailbox_with_no_mail: '📭',
  postbox: '📮', ballot_box: '🗳️', wastebasket: '🗑️', file_cabinet: '🗄️', briefcase: '💼',
  scroll: '📜', receipt: '🧾', hourglass_flowing_sand: '⏳', watch: '⌚', alarm_clock: '⏰',
  stopwatch: '⏱️', timer_clock: '⏲️', clock3: '🕒', clock6: '🕕', clock9: '🕘', clock12: '🕛',

  // ─── places and travel ──────────────────────────────────────────────────
  house: '🏠', house_with_garden: '🏡', office: '🏢', hospital: '🏥', bank: '🏦', school: '🏫',
  factory: '🏭', construction: '🚧', building_construction: '🏗️', car: '🚗', red_car: '🚗',
  taxi: '🚕', bus: '🚌', truck: '🚚', articulated_lorry: '🚛', tractor: '🚜', ambulance: '🚑',
  fire_engine: '🚒', police_car: '🚓', bike: '🚲', airplane: '✈️', ship: '🚢', boat: '⛵',
  sailboat: '⛵', train: '🚆', fuelpump: '⛽', world_map: '🗺️', compass: '🧭', mountain: '⛰️',
  camping: '🏕️', beach_umbrella: '🏖️', desert: '🏜️', earth_americas: '🌎',
  globe_with_meridians: '🌐', moyai: '🗿',

  // ─── weather and nature ─────────────────────────────────────────────────
  sunny: '☀️', cloud: '☁️', partly_sunny: '⛅', cloud_with_rain: '🌧️', tornado: '🌪️',
  umbrella: '☔', open_umbrella: '☂️', snowflake: '❄️', snowman: '⛄', rainbow: '🌈', ocean: '🌊',
  crescent_moon: '🌙', full_moon: '🌕', new_moon: '🌑', star2: '🌟', comet: '☄️', hotsprings: '♨️',
  seedling: '🌱', evergreen_tree: '🌲', deciduous_tree: '🌳', palm_tree: '🌴', cactus: '🌵',
  herb: '🌿', shamrock: '☘️', four_leaf_clover: '🍀', fallen_leaf: '🍂', leaves: '🍃',
  maple_leaf: '🍁', mushroom: '🍄', tulip: '🌷', rose: '🌹', sunflower: '🌻', blossom: '🌼',
  cherry_blossom: '🌸', hibiscus: '🌺', bouquet: '💐',
  dog: '🐶', cat: '🐱', mouse: '🐭', rabbit: '🐰', fox_face: '🦊', bear: '🐻', panda_face: '🐼',
  koala: '🐨', tiger: '🐯', lion: '🦁', cow: '🐮', pig: '🐷', frog: '🐸', monkey_face: '🐵',
  hear_no_evil: '🙉', speak_no_evil: '🙊', chicken: '🐔', penguin: '🐧', bird: '🐦',
  baby_chick: '🐤', owl: '🦉', eagle: '🦅', duck: '🦆', unicorn: '🦄', bee: '🐝', honeybee: '🐝',
  butterfly: '🦋', snail: '🐌', ant: '🐜', spider: '🕷️', turtle: '🐢', snake: '🐍', octopus: '🐙',
  crab: '🦀', fish: '🐟', tropical_fish: '🐠', whale: '🐳', dolphin: '🐬', shark: '🦈', horse: '🐴',
  sloth: '🦥', sheep: '🐑', goat: '🐐', dragon: '🐉', 't-rex': '🦖', sauropod: '🦕', paw_prints: '🐾',
  feet: '🐾',

  // ─── food and drink ─────────────────────────────────────────────────────
  apple: '🍎', green_apple: '🍏', banana: '🍌', grapes: '🍇', watermelon: '🍉', strawberry: '🍓',
  peach: '🍑', cherries: '🍒', lemon: '🍋', tangerine: '🍊', pineapple: '🍍', avocado: '🥑',
  tomato: '🍅', eggplant: '🍆', carrot: '🥕', corn: '🌽', hot_pepper: '🌶️', broccoli: '🥦',
  bread: '🍞', croissant: '🥐', cheese: '🧀', egg: '🥚', bacon: '🥓', hamburger: '🍔', fries: '🍟',
  hotdog: '🌭', taco: '🌮', burrito: '🌯', sandwich: '🥪', popcorn: '🍿', sushi: '🍣', ramen: '🍜',
  spaghetti: '🍝', rice: '🍚', curry: '🍛', doughnut: '🍩', cookie: '🍪', cake: '🍰',
  birthday: '🎂', cupcake: '🧁', pie: '🥧', chocolate_bar: '🍫', candy: '🍬', lollipop: '🍭',
  ice_cream: '🍨', icecream: '🍦', tea: '🍵', beers: '🍻', wine_glass: '🍷', cocktail: '🍸',
  tropical_drink: '🍹', champagne: '🍾', clinking_glasses: '🥂', tumbler_glass: '🥃',
  cup_with_straw: '🥤', milk_glass: '🥛', fork_and_knife: '🍴', plate_with_cutlery: '🍽️',

  // ─── activities and things ──────────────────────────────────────────────
  soccer: '⚽', basketball: '🏀', football: '🏈', baseball: '⚾', tennis: '🎾', volleyball: '🏐',
  golf: '⛳', bowling: '🎳', dart: '🎯', video_game: '🎮', joystick: '🕹️', game_die: '🎲',
  jigsaw: '🧩', chess_pawn: '♟️', art: '🎨', performing_arts: '🎭', microphone: '🎤',
  headphones: '🎧', musical_note: '🎵', notes: '🎶', guitar: '🎸', musical_keyboard: '🎹',
  trumpet: '🎺', violin: '🎻', drum: '🥁', clapper: '🎬', ticket: '🎫', tickets: '🎟️',
  medal_sports: '🏅', medal_military: '🎖️', '1st_place_medal': '🥇', '2nd_place_medal': '🥈',
  '3rd_place_medal': '🥉', balloon: '🎈', ribbon: '🎀', christmas_tree: '🎄', jack_o_lantern: '🎃',
  fireworks: '🎆', sparkler: '🎇', crown: '👑', tophat: '🎩', mortar_board: '🎓', eyeglasses: '👓',
  dark_sunglasses: '🕶️', necktie: '👔', shirt: '👕', jeans: '👖', dress: '👗', lipstick: '💄',
  ring: '💍', handbag: '👜', shopping_cart: '🛒', shopping: '🛍️',
}

const NAMES = { ...MORE, ...EMOJI }

/** The six a post offers without opening the grid. */
export const QUICK = ['+1', 'heart', 'tada', 'laughing', 'eyes', 'white_check_mark']

/** Whether a name is in either table. */
export const isEmoji = (name) => Object.hasOwn(NAMES, name)

/** The glyph for a name, or `:name:` when neither table knows it. */
export const glyphOf = (name) => (isEmoji(name) ? NAMES[name] : `:${name}:`)

/**
 * A post's Markdown with each known `:name:` drawn as its glyph. Code fences and inline
 * code are left alone, so `:name:` inside a snippet stays what was typed.
 */
export function emojify(text) {
  if (!text || !text.includes(':')) return text
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, i) =>
    i % 2 ? part : part.replace(/:([a-z0-9_+-]+):/gi, (m, name) => {
      const key = name.toLowerCase()
      return isEmoji(key) ? NAMES[key] : m
    })).join('')
}
