// One "understand" step for every message the shop receives, from the owner or a customer, in any language:
// the model answers with one flat JSON object (language, English translation, relevant or not, intent, items,
// amount, person, a short question when unclear). The khata code acts on that JSON with its own safety rules
// (amounts must be in the message, payments need payment words, the owner confirms orders); the regex rules in
// agent-core.js are only the fallback when no model answers. Prompts are plain text with few-shot examples so a
// small 7-8B open-source instruct model can follow them as well as a large one.
'use strict';
const C = require('./agent-core.js');

// ------------------------------------------------------------------ languages
const LANG_NAMES = { hinglish: 'Hinglish (Hindi in Latin letters)', hi: 'Hindi (Devanagari script)', mr: 'Marathi (Devanagari script)', en: 'English',
  ta: 'Tamil', te: 'Telugu', bn: 'Bengali', gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi', or: 'Odia', ur: 'Urdu' };
const LANG_ALIAS = { hindi: 'hi', marathi: 'mr', english: 'en', tamil: 'ta', telugu: 'te', bengali: 'bn', bangla: 'bn', gujarati: 'gu', kannada: 'kn',
  malayalam: 'ml', punjabi: 'pa', odia: 'or', oriya: 'or', urdu: 'ur', 'hi-latn': 'hinglish', 'hi_latn': 'hinglish', hinglish: 'hinglish', 'mr-latn': 'mr', minglish: 'mr' };
function normLang(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (LANG_NAMES[s]) return s;
  if (LANG_ALIAS[s]) return LANG_ALIAS[s];
  const two = s.slice(0, 2);
  return /^[a-z]{2}$/.test(two) && LANG_NAMES[two] ? two : /^[a-z]{2,3}$/.test(s) ? s : null;
}
const MR_DV = /(आहे|आहेत|नाही|पाहिजे|द्या|किती|माझ|उद्या|लिहा|पाठवा|झाले|आणि|साखर|बाकी आहे|करा)/;
const MR_LATN = /\b(aahe|ahe|aahet|pahije|dya|kiti|majha|maza|majhe|udya|liha|pathva|zale|jhale|ani|sakhar|kara na|nahi ka|ho na)\b/i;
const HI_LATN = /\b(hai|hain|ka|ki|ke|ko|kya|kitna|kitne|karo|kar|dena|mera|mere|mujhe|nahi|nhi|chahiye|bhej|wala|vala|bhi|aur|tha|dunga|diya|diye|likho|yaar|bhaiya|ji|baki|baaki|kal|abhi|maine|aap|se|mein|men)\b/gi;
const EN_WORDS = /\b(the|is|are|you|your|i|my|me|please|send|how|much|have|has|will|pay|paid|owe|what|when|where|can|need|want|and|of|to|in|stock|today|yesterday|tomorrow)\b/gi;
/** The language by script and a few marker words: the fallback when no model answers. */
function detectLang(text) {
  const s = String(text || '');
  if (/[஀-௿]/.test(s)) return 'ta';
  if (/[ఀ-౿]/.test(s)) return 'te';
  if (/[ঀ-৿]/.test(s)) return 'bn';
  if (/[઀-૿]/.test(s)) return 'gu';
  if (/[ಀ-೿]/.test(s)) return 'kn';
  if (/[ഀ-ൿ]/.test(s)) return 'ml';
  if (/[਀-੿]/.test(s)) return 'pa';
  if (/[؀-ۿ]/.test(s)) return 'ur';
  if (/[ऀ-ॿ]/.test(s)) return MR_DV.test(s) ? 'mr' : 'hi';
  if (!/[a-z]/i.test(s)) return null;
  if (MR_LATN.test(s)) return 'mr';
  const hi = (s.match(HI_LATN) || []).length, en = (s.match(EN_WORDS) || []).length;
  return hi > en || (hi && hi === en) ? 'hinglish' : en ? 'en' : 'hinglish';
}
/** The language a reply goes out in. Hindi heard in a voice note is answered in Hinglish (the script was the STT's choice, not the customer's). */
function replyLang(lang, source) {
  if (!lang) return null;
  if (lang === 'hi' && source === 'voice') return 'hinglish';
  return lang;
}
const needsTranslation = (lang) => !!lang && lang !== 'hinglish';

// ------------------------------------------------------------------ intents
const CUSTOMER_U = ['order', 'add_to_order', 'balance', 'payment_claim', 'promise', 'udhaar_request', 'confirm_yes', 'confirm_no', 'vouch', 'greeting', 'question', 'balance_dispute', 'correction', 'chitchat', 'abuse', 'opt_out'];
const OWNER_U = ['udhaar', 'jama', 'list', 'list_edit', 'balance', 'summary', 'remind', 'remind_all', 'undo', 'set_phone', 'add_customer', 'remove_customer', 'restore_customer', 'promise', 'supplier', 'week', 'wholesale', 'help', 'chitchat', 'unknown'];
// older or shorter names a model may use, and the khata's own names
const ALIAS = { credit: 'udhaar', payment: 'jama', query: 'balance', pay_claim: 'payment_claim', abusive: 'abuse', paid: 'payment_claim', greet: 'greeting', complaint: 'question', add_item: 'add_to_order', addtoorder: 'add_to_order', other: 'unknown', irrelevant: 'chitchat', spam: 'chitchat', optout: 'opt_out', dispute: 'balance_dispute', claim: 'balance_dispute', balance_claim: 'balance_dispute', wrong_entry: 'balance_dispute', fix: 'correction' };
const TO_CUSTOMER = { order: 'order', add_to_order: 'order', balance: 'balance', payment_claim: 'pay_claim', promise: 'promise', udhaar_request: 'question', confirm_yes: 'confirm_yes', confirm_no: 'confirm_no', vouch: 'vouch', greeting: 'greeting', question: 'question', balance_dispute: 'dispute', correction: 'correction', chitchat: 'chitchat', abuse: 'abusive', opt_out: 'opt_out' };
const TO_OWNER = { udhaar: 'credit', jama: 'payment', list: 'credit', list_edit: 'unknown', balance: 'query', summary: 'summary', remind: 'remind', remind_all: 'remind_all', undo: 'undo', set_phone: 'set_phone', add_customer: 'set_phone', remove_customer: 'remove_customer', restore_customer: 'restore_customer', promise: 'promise', supplier: 'supplier', week: 'week', wholesale: 'wholesale', help: 'help', chitchat: 'help', unknown: 'unknown' };

// ------------------------------------------------------------------ prompts
const KEYS = ['lang', 'english', 'relevant', 'reason', 'intent', 'items', 'amount', 'person', 'entries', 'phone', 'due_date', 'method', 'canon', 'confidence', 'ask'];
const FORMAT = 'Answer with ONE JSON object and nothing else, with exactly these keys:\n' +
  '{"lang": "", "english": "", "relevant": true, "reason": "", "intent": "", "items": [], "amount": null, "person": "", "entries": [], "phone": "", "due_date": "", "method": "", "canon": "", "confidence": 0.9, "ask": ""}\n' +
  'lang: the language of the message: hinglish (Hindi in Latin letters), hi (Hindi in Devanagari), mr (Marathi, either script), en (English), or another ISO code (ta, te, bn, gu, kn, ml, pa, ur).\n' +
  'english: the message translated to plain English.\n' +
  'relevant: true if the message is about the shop (buying, udhaar, paying, the hisaab, a complaint, a real question); false for jokes, flirting, spam, abuse, random text. reason: a few words why.\n' +
  'items: [{"name": "", "qty": null, "unit": "", "price": null}] for every product named. name: the common shop name in Latin letters as an Indian kirana shop says it ' +
  '(aata, cheeni, chaaval, daal, tel, doodh, sabun, shampoo, Parle-G, Maggi), brand and variant words kept (e.g. "anti dandruff shampoo"). ' +
  'qty: a number only if said. unit: kg, g, l, ml, pkt, pc, bottle, dozen or "". price: rupees only if the message says the price of that item, else null.\n' +
  'amount: rupees as a number only if the message states money, else null. Never guess an amount.\n' +
  'person: the person named (with ji/bhai/didi if said), else "". entries: only when the message has amounts for TWO OR MORE different people, one ' +
  '{"person": "", "amount": null, "type": "udhaar"} (type udhaar or jama) per person, else []. A person\'s name is never an item. phone: a 10-digit number if given, else "". due_date: YYYY-MM-DD for a promised payment day, else "". ' +
  'method: "cash" or "upi" when a payment is mentioned, else "".\n' +
  'confidence: 0 to 1, how sure you are about intent. ask: "" when clear; else ONE short question back, in the same language as the message.';

const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function nextWeekday(today, dow) {
  const d = new Date(today + 'T00:00:00Z');
  const add = ((dow - d.getUTCDay()) + 7) % 7 || 7;
  return new Date(d.getTime() + add * 864e5).toISOString().slice(0, 10);
}
const shot = (o) => JSON.stringify(Object.assign({ lang: 'hinglish', english: '', relevant: true, reason: '', intent: '', items: [], amount: null, person: '', entries: [], phone: '', due_date: '', method: '', canon: '', confidence: 0.9, ask: '' }, o));
const it = (name, qty, unit, price) => ({ name, qty: qty == null ? null : qty, unit: unit || '', price: price == null ? null : price });

/** Real messages from the shop's WhatsApp (18 Oct) plus Marathi, Hindi, English and junk. */
function customerShots(today) {
  const fri = nextWeekday(today, 5);
  return [
    ['Shampoo bhi tha yaar usako bhi add karo', { english: 'There was shampoo too, add that as well', reason: 'adds an item to the order', intent: 'add_to_order', items: [it('shampoo')] }],
    ['entry anti dandruff shampoo add karo.', { english: 'Add anti dandruff shampoo to the entry', reason: 'adds an item', intent: 'add_to_order', items: [it('anti dandruff shampoo')] }],
    ['mere ko pachaas vaala condom de do.', { english: 'Give me the 50 rupee condom', reason: 'orders an item', intent: 'order', items: [it('condom', null, '', 50)] }],
    ['ek kilo chaaval, do kilo daal', { english: '1 kg rice, 2 kg lentils', reason: 'order', intent: 'order', items: [it('chaaval', 1, 'kg'), it('daal', 2, 'kg')] }],
    ['khaate men likho abhi paise naheen hai mere paas. main jab aaoonga tab doonga.', { english: 'Write it in the khata, I have no money now. I will pay when I come.', reason: 'wants it on credit', intent: 'udhaar_request' }],
    ['माझे किती बाकी आहे?', { lang: 'mr', english: 'How much do I owe?', reason: 'asks balance', intent: 'balance' }],
    ['उद्या 2 किलो साखर आणि 1 पाकीट दूध पाठवा', { lang: 'mr', english: 'Send 2 kg sugar and 1 packet milk tomorrow', reason: 'order', intent: 'order', items: [it('cheeni', 2, 'kg'), it('doodh', 1, 'pkt')] }],
    ['मुझे एक लीटर सरसों का तेल और दो मैगी भेज दीजिए', { lang: 'hi', english: 'Please send me one litre mustard oil and two Maggi', reason: 'order', intent: 'order', items: [it('sarson tel', 1, 'l'), it('Maggi', 2, 'pkt')] }],
    ['I paid 200 by UPI just now', { lang: 'en', english: 'I paid 200 by UPI just now', reason: 'says paid', intent: 'payment_claim', amount: 200, method: 'upi' }],
    ['Shuknivaar ko dunga', { english: 'I will pay on Friday', reason: 'promise to pay', intent: 'promise', due_date: fri }],
    ['Mera udhar bs 40 rupaye hai', { english: 'My udhaar is only 40 rupees', reason: 'says the khata total is wrong, claims 40', intent: 'balance_dispute', amount: 40 }],
    ['daal maine us din cash de diya tha, sirf aata likho', { english: 'I paid cash for the daal that day, write only the aata', reason: 'corrects an entry', intent: 'correction', items: [it('daal'), it('aata')] }],
    ['Gupta ji pe mera 5000 rupaye udhar hai', { english: 'Gupta ji, I owe 5000 rupees', reason: 'talks about his udhaar', intent: 'question', amount: 5000, person: 'Gupta ji', confidence: 0.6 }],
    ['Old is gold', { lang: 'en', english: 'Old is gold', relevant: false, reason: 'a proverb, not shop talk', intent: 'chitchat' }],
    ['Nudes de diya', { english: 'Gave nudes', relevant: false, reason: 'vulgar, not money', intent: 'abuse' }],
    ['suna kya?', { english: 'Did you hear?', relevant: false, reason: 'just a ping', intent: 'chitchat', confidence: 0.6, ask: 'Haan ji, boliye kya chahiye?' }],
    ['Nhi chahiye gupta kirana se kuch bhi mujhe', { english: 'I do not want anything from Gupta Kirana', reason: 'wants no messages', intent: 'opt_out' }]
  ];
}
function ownerShots(today) {
  const fri = nextWeekday(today, 5);
  return [
    ['sharma ji ne 400ka saman kiya', { english: 'Sharma ji took goods worth 400', reason: 'udhaar entry', intent: 'udhaar', amount: 400, person: 'Sharma ji', canon: 'Sharma ji ne 400 ka saman liya' }],
    ['meena 220 diye', { english: 'Meena paid 220', reason: 'payment', intent: 'jama', amount: 220, person: 'Meena', canon: 'Meena ne 220 jama kiye' }],
    ['Aaj ka hisab', { english: "Today's accounts", reason: 'summary', intent: 'summary', canon: 'aaj ka hisaab' }],
    ['Krish ki list: 2 kilo aata 80, ek Parle-G 10, doodh', { english: "Krish's list: 2 kg flour 80, one Parle-G 10, milk", reason: 'item list on credit', intent: 'list', person: 'Krish', items: [it('aata', 2, 'kg', 80), it('Parle-G', 1, '', 10), it('doodh')], canon: 'Krish ki list: aata 2 kilo 80, Parle-G 10, doodh' }],
    ['शर्मा जींचे 500 रुपये उधार लिहा, शुक्रवारी देतील', { lang: 'mr', english: 'Write 500 rupees udhaar for Sharma ji, he will pay on Friday', reason: 'udhaar entry', intent: 'udhaar', amount: 500, person: 'Sharma ji', due_date: fri, canon: 'Sharma ji 500 udhaar, Shukravar ko denge' }],
    ['Sharma took groceries worth 340, will pay on Friday', { lang: 'en', english: 'Sharma took groceries worth 340, will pay on Friday', reason: 'udhaar entry', intent: 'udhaar', amount: 340, person: 'Sharma ji', due_date: fri, canon: 'Sharma ji ne 340 ka saman liya, Shukravar ko denge' }],
    ['Krish ki list mein do Maggi aur jod do', { english: "Add two more Maggi to Krish's list", reason: 'changes a list already written', intent: 'list_edit', person: 'Krish', items: [it('Maggi', 2)], canon: 'Krish ki list mein 2 Maggi jod do' }],
    ['krish wali list se doodh nikal do', { english: "Remove milk from Krish's list", reason: 'changes a list already written', intent: 'list_edit', person: 'Krish', items: [it('doodh')], canon: 'Krish ki list se doodh hata do' }],
    ['Agrawal traders ko order: 10 kilo cheeni, 5 kilo aata', { english: 'Order to Agrawal Traders: 10 kg sugar, 5 kg flour', reason: 'stock order', intent: 'wholesale', person: 'Agrawal Traders', items: [it('cheeni', 10, 'kg'), it('aata', 5, 'kg')], canon: 'Agrawal Traders ko order: 10 kilo cheeni, 5 kilo aata' }],
    ['Ramesh ka naya khata kholo, number 9876543210', { english: 'Open a new khata for Ramesh, number 9876543210', reason: 'new customer', intent: 'add_customer', person: 'Ramesh', phone: '9876543210', canon: 'Ramesh ka number 9876543210' }],
    ['verma ka 250 aur pappu ka 120 likh do', { english: 'Write 250 for Verma and 120 for Pappu', reason: 'two people, two udhaar entries', intent: 'udhaar', entries: [{ person: 'Verma ji', amount: 250, type: 'udhaar' }, { person: 'Pappu', amount: 120, type: 'udhaar' }], canon: '' }],
    ['galti ho gayi sharma ji ka 340 nahi 430 tha', { english: 'Mistake: Sharma ji\'s entry was 430, not 340', reason: 'fixes the amount of Sharma ji\'s own entry', intent: 'undo', person: 'Sharma ji', amount: 430, canon: '' }],
    ['Pappu ko hatao', { english: 'Remove Pappu', reason: 'remove customer', intent: 'remove_customer', person: 'Pappu', canon: 'Pappu ko hatao' }],
    ['haan wo... uska... kal wala', { english: 'yes that... his... yesterday one', relevant: true, reason: 'too unclear', intent: 'unknown', confidence: 0.2, ask: 'Kiska aur kitne ka hisaab likhun?' }]
  ];
}

function pastTurns(shots) {
  const out = [];
  for (const [u, a] of shots) out.push({ role: 'user', content: u }, { role: 'assistant', content: shot(a) });
  return out;
}

/**
 * Chat messages for a customer's message. The last message is the customer's own words, unchanged.
 * ctx: { asking: text of the question the shop is waiting on, order: open order text,
 *        history: [{who: 'shop'|'customer', text}] (last few messages), dispute: open "galat" label, balance, entries: [text] }
 */
function customerContext(ctx) {
  const lines = [];
  if (ctx.balance != null) lines.push('Their khata balance now: ' + (ctx.balance < 0 ? 'Rs 0 owed (Rs ' + -ctx.balance + ' paid in advance)' : 'Rs ' + ctx.balance + ' owed') + '.');
  if (ctx.entries && ctx.entries.length) lines.push('Last entries: ' + ctx.entries.join('; ') + '.');
  if (ctx.dispute) lines.push('Open dispute: the customer said "galat" (wrong) about ' + ctx.dispute + '; the owner has not settled it yet.');
  if (ctx.history && ctx.history.length) lines.push('Recent conversation (oldest first):\n' + ctx.history.map((h) => (h.who === 'shop' ? 'Shop bot: ' : 'Customer: ') + h.text).join('\n'));
  return lines.length ? '\nContext, to understand the new message (do not answer it):\n' + lines.join('\n') + '\n' : '';
}
function customerMessages(state, c, text, ctx) {
  ctx = ctx || {};
  const shop = state.shop || {};
  const known = C.rateList(state).slice(0, 40).map((r) => r.name).join(', ');
  const system = 'You read ONE WhatsApp message that a CUSTOMER sent to ' + (shop.name || 'a kirana shop') + ', a small neighbourhood kirana (grocery) shop in ' + (shop.city || 'India') +
    ' that gives regular households goods on udhaar (credit). The customer may write or speak (voice-note transcript with misheard words) in any Indian language or English, in any script.\n' +
    'Customer: ' + c.name + (c.guest ? ' (new number, no khata yet)' : ' (has a khata)') + '.' + (ctx.order ? ' Their open order: ' + ctx.order + '.' : '') +
    (ctx.asking ? ' The shop is waiting for their answer to: "' + ctx.asking + '".' : '') + (known ? '\nItems the shop knows: ' + known + '.' : '') + '\n' + customerContext(ctx) +
    'intent, exactly one of:\n' +
    'order = wants to buy items, in any words ("de do", "bhej dena", "chahiye", "pathva", "send");\n' +
    'add_to_order = adds items to an order already sent ("ye bhi add karo", "ek aur", "shampoo bhi");\n' +
    'balance = asks how much they owe or for their hisaab;\n' +
    'payment_claim = says they ALREADY paid money ("cash de diya", "UPI kar diya", "paid 200"). Not money (photos, insults, jokes) is never payment_claim. "Kal dunga" is promise;\n' +
    'promise = will pay later or names a day; udhaar_request = asks to write their purchase on credit / in the khata;\n' +
    'confirm_yes / confirm_no = says an entry, bill or question is right / wrong (haan, ho, yes / galat, nahi, no);\n' +
    (C.FEATURES.vouch ? 'vouch = vouches for a new person with their phone number; ' : '') + 'greeting = only a greeting;\n' +
    'balance_dispute = says their balance or an entry is wrong, or claims a different total ("mera udhaar bas 40 hai", "itna nahi liya", "maine 162 ka nahi liya"); amount = the amount THEY claim;\n' +
    'correction = corrects a detail of an earlier order or entry ("daal nahi chaaval tha", "2 nahi 1 kilo", "daal ka de diya tha, aata baaki");\n' +
    'question = any other real message that needs the shopkeeper (complaint, availability, delivery, a question);\n' +
    'Use the context: a message right after an entry or a "galat" about the money is usually balance_dispute or correction, never chitchat.\n' +
    'chitchat = jokes, flirting, proverbs, emoji, pings, random text; abuse = insults, vulgar or sexual text, threats; opt_out = wants no more messages or service.\n' +
    'When unsure between payment_claim and anything else, never choose payment_claim.\n' + FORMAT;
  return [{ role: 'system', content: system }].concat(pastTurns(customerShots(state.today)), [{ role: 'user', content: String(text) }]);
}

function ownerMessages(state, text) {
  const shop = state.shop || {};
  const names = C.live(state).map((c) => c.name).join(', ') || '(none yet)';
  const sups = [...new Set((state.supplies || []).map((k) => k.name))].join(', ') || '(none yet)';
  const whs = (state.wholesalers || []).map((w) => w.name + (w.items && w.items.length ? ' (' + w.items.join(', ') + ')' : '')).join('; ') || '(none yet)';
  const today = state.today;
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  const system = 'You read ONE WhatsApp message from the SHOP OWNER (' + (shop.owner || 'the owner') + ') of ' + (shop.name || 'a kirana shop') + ', a small kirana (grocery) shop in ' + (shop.city || 'India') +
    ' that keeps an udhaar khata (credit book) for regular households and buys stock from wholesalers. The owner types or speaks (voice-note transcript: misheard names, filler words, amounts as words like "paanch sau" 500, "dedh hazaar" 1500) in Hinglish, Hindi, Marathi or English, in any script.\n' +
    'Today is ' + today + ' (' + WEEKDAY_EN[dow] + '). People in the khata: ' + names + '. Suppliers the shop owes: ' + sups + '. Wholesalers: ' + whs + '.\n' +
    'intent, exactly one of:\n' +
    'udhaar = someone took goods or money on credit; jama = someone paid the shop back; list = an item-by-item list for one person (items with prices as said); list_edit = change a list ALREADY written for one person (add / remove an item, fix a price, or replace it);\n' +
    'balance = one person\'s baaki; summary = the overall hisaab (aaj ka hisaab, kaun kaun baaki); remind = remind one person; remind_all = remind everyone who owes;\n' +
    'undo = cancel or fix an entry (person = whose entry; a fix like "340 nahi 430 tha" is undo with that person, never another person\'s entry); set_phone = save a person\'s number; add_customer = open a new khata; remove_customer / restore_customer = "<name> ko hatao" / "<name> ko wapas lao";\n' +
    'promise = a person will pay on a day (no new goods); supplier = the SHOP\'s own udhaar with a wholesaler or trader (maal udhaar, paid the trader, kisko kitna dena hai); week = this week\'s hisaab;\n' +
    'wholesale = ordering stock for the shop from a wholesaler, a wholesaler\'s number, who supplies what, "maal aa gaya", "wholesaler list";\n' +
    'help = asks what you can do; chitchat = greeting or small talk; unknown = anything else or too garbled.\n' +
    'Rules: never invent an amount, a name or a payment; if one is missing leave it empty and put the question in ask. Reuse the exact spelling of a known name when it matches. ' +
    'canon: the same command as one short clean Hinglish line in Latin letters with digits, in these shapes: "<Name> ne 340 ka saman liya", "<Name> ne 200 jama kiye", "<Name> ki list: aata 2 kilo 80, doodh", "<Name> ki list mein 2 Maggi jod do", "<Name> ki list se doodh hata do", "<Name> ki list mein aata 90 ka tha", "<Name> ki list badlo: aata 2 kilo 80", ' +
    '"<Name> ka kitna baaki hai", "<Name> ka number 98xxxxxxxx", "Agrawal Traders se 5000 ka maal udhaar", "Agrawal Traders ko order: 10 kilo cheeni"; never add a price that was not said.\n' + FORMAT;
  return [{ role: 'system', content: system }].concat(pastTurns(ownerShots(today)), [{ role: 'user', content: String(text) }]);
}

// ------------------------------------------------------------------ validation
const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v) => { const n = typeof v === 'string' ? parseFloat(v.replace(/[₹,\s]/g, '')) : v; return typeof n === 'number' && isFinite(n) && n > 0 ? n : null; };
const UNIT_OK = { kg: 'kg', kilo: 'kg', kgs: 'kg', g: 'g', gm: 'g', gram: 'g', grams: 'g', l: 'l', ltr: 'l', litre: 'l', liter: 'l', ml: 'ml', pkt: 'pkt', packet: 'pkt', pack: 'pkt', pouch: 'pkt', pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc', bottle: 'bottle', dozen: 'dozen' };
function cleanItems(v) {
  if (typeof v === 'string') return v.trim() ? [{ name: str(v, 80), qty: null, unit: null, price: null, loose: true }] : [];
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v.slice(0, 20)) {
    const o = typeof x === 'string' ? { name: x } : x && typeof x === 'object' ? x : null;
    const name = o && str(o.name || o.item || '', 60).replace(/^[\s\-•*]+/, '');
    if (!name || !/[\p{L}]/u.test(name)) continue;
    const unit = UNIT_OK[str(o.unit || '', 12).toLowerCase()] || null;
    out.push({ name, qty: num(o.qty != null ? o.qty : o.quantity), unit, price: num(o.price) });
  }
  return out;
}
function cleanEntries(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 10).map((e) => e && typeof e === 'object' ? { person: str(e.person || e.name || '', 60), amount: num(e.amount), type: /jama|payment|paid/i.test(str(e.type, 12)) ? 'jama' : 'udhaar' } : null)
    .filter((e) => e && e.person && e.amount);
}
/**
 * The model's JSON, checked against the schema. Throws (so the next provider, then the rules, answer) when the
 * intent is not one this role allows. Missing optional keys get safe empty values.
 */
function normalize(j, role) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('LLM reply is not an object');
  let intent = str(j.intent, 40).toLowerCase().replace(/[\s-]+/g, '_');
  intent = ALIAS[intent] || intent;
  const allowed = role === 'owner' ? OWNER_U : CUSTOMER_U;
  if (allowed.indexOf(intent) < 0) throw new Error('LLM intent not allowed: ' + String(j.intent).slice(0, 40));
  let relevant = j.relevant;
  if (typeof relevant === 'string') relevant = /^(true|yes|1)$/i.test(relevant.trim()) ? true : /^(false|no|0)$/i.test(relevant.trim()) ? false : null;
  if (typeof relevant !== 'boolean') relevant = null; // not said: the khata code does not guess
  let conf = typeof j.confidence === 'string' ? parseFloat(j.confidence) : j.confidence;
  conf = typeof conf === 'number' && isFinite(conf) ? Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf)) : null;
  const person = str(j.person != null ? j.person : j.name, 60);
  const phone = (String(j.phone || '').replace(/\D/g, '').match(/[6-9]\d{9}$/) || [''])[0];
  const due = str(j.due_date, 10);
  const method = /^(cash|upi)$/i.test(str(j.method, 8)) ? str(j.method, 8).toLowerCase() : '';
  return {
    lang: normLang(j.lang || j.language), english: str(j.english, 400), relevant, reason: str(j.reason, 120), intent,
    items: cleanItems(j.items), amount: num(j.amount), person, phone, dueDate: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '', method,
    canon: str(j.canon, 300), confidence: conf, ask: str(j.ask, 160), entries: cleanEntries(j.entries)
  };
}

// ------------------------------------------------------------------ to the khata's intents
/** A customer's understanding as handleCustomerMessage's intent (safety rules applied in agent-core). */
function toCustomerIntent(u, text) {
  if (u.intent === 'vouch' && !C.FEATURES.vouch) u = Object.assign({}, u, { intent: 'question' });
  const ci = C.customerIntentFromLlm({ intent: TO_CUSTOMER[u.intent], method: u.method, amount: u.amount || 0 }, text);
  if (!ci) return null;
  // a payment needs payment words in the message itself; in a script the rules cannot read (Gujarati, Tamil, ...)
  // the model's own English translation must carry them. Latin-script messages stay on the strict check.
  if (u.intent === 'payment_claim' && ci.intent === 'question' && /[\u0900-\u0DFF\u0600-\u06FF]/.test(text) && !/[a-z]/i.test(text) && C.payLanguage(u.english || '')) {
    ci.intent = 'pay_claim'; ci.method = u.method === 'cash' || /\bcash\b/i.test(u.english) ? 'cash' : 'upi';
  }
  return Object.assign(ci, {
    llmIntent: u.intent, add: u.intent === 'add_to_order', udhaar: u.intent === 'udhaar_request',
    items: u.items.filter((x) => !x.loose), lang: u.lang, english: u.english, relevant: u.relevant, reason: u.reason, confidence: u.confidence, ask: u.ask || null
  });
}
/** An owner's understanding as applyIntent's intent. The amount must be stated in the message (intentFromLlm drops it otherwise). */
function toOwnerIntent(u, text) {
  const items = u.items.map((x) => x.loose ? x.name : [x.name, x.qty != null ? x.qty + (x.unit ? ' ' + x.unit : '') : '', x.price != null ? x.price : ''].filter((p) => p !== '').join(' ')).join(', ');
  const oi = C.intentFromLlm({ intent: TO_OWNER[u.intent], name: u.person, items, amount: u.amount || 0, due_date: u.dueDate, phone: u.phone, canon: u.canon, ask: u.ask }, text);
  if (u.intent === 'add_customer') oi.create = true;
  return Object.assign(oi, { llmIntent: u.intent, lang: u.lang, english: u.english, relevant: u.relevant, confidence: u.confidence });
}

// ------------------------------------------------------------------ rules (fallback, and the eval's baseline)
const OWNER_FROM_RULES = { credit: 'udhaar', payment: 'jama', query: 'balance', summary: 'summary', remind: 'remind', remind_all: 'remind_all', undo: 'undo', set_phone: 'set_phone', promise: 'promise', help: 'help', remove_customer: 'remove_customer', restore_customer: 'restore_customer', choice: 'unknown', unknown: 'unknown' };
const CUSTOMER_FROM_RULES = { dispute: 'balance_dispute', correction: 'correction', order: 'order', balance: 'balance', pay_claim: 'payment_claim', promise: 'promise', confirm_yes: 'confirm_yes', confirm_no: 'confirm_no', vouch: 'vouch', greeting: 'greeting', question: 'question', chitchat: 'chitchat', abusive: 'abuse', opt_out: 'opt_out' };
/** What the regex rules make of a message, in the same shape as a model's answer. */
function rulesUnderstand(state, role, text, c) {
  const lang = detectLang(text);
  if (role === 'owner') {
    let intent, wsLines = [];
    const le = C.listEditIntent(state, text);
    const li = !le && C.listIntent(state, text), ws = !le && !li && C.parseWholesale(state, text);
    if (le) intent = 'list_edit';
    else if (li) intent = 'list';
    else if (ws) { intent = 'wholesale'; wsLines = (ws.groups || []).reduce((a, g) => a.concat(g.lines || []), ws.lines || []); }
    else if (C.parseSupplier(state, text)) intent = 'supplier';
    else if (C.removeIntent(state, text)) intent = C.removeIntent(state, text).intent;
    else intent = OWNER_FROM_RULES[C.parseOwnerMessage(text, state.today).intent] || 'unknown';
    const p = C.parseOwnerMessage(text, state.today);
    return { lang, english: '', relevant: intent !== 'unknown', intent, items: (li ? li.lineParse.lines : wsLines).map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, price: l.price })), amount: p.amount, person: le ? le.name : li ? li.name || p.name : p.name, parser: 'rules' };
  }
  const ci = C.customerIntentRules(state, c, text);
  const pre = C.customerPrefilter(text);
  const co = ci.intent !== 'pay_claim' && !pre ? C.customerOrder(state, text) : { lines: [] };
  let intent = CUSTOMER_FROM_RULES[ci.intent] || 'question';
  // the same test handleCustomerMessage uses: an order verb, or a remembered rate / a quantity
  if (co.lines.length && (co.cue || co.lines.some((l) => l.from === 'memory' || l.unit))) intent = co.add ? 'add_to_order' : 'order';
  else if (C.orderReply(text) === 'udhaar') intent = 'udhaar_request';
  return { lang, english: '', relevant: ['chitchat', 'abuse', 'greeting'].indexOf(intent) < 0, intent, items: co.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, price: l.price })), amount: null, person: '', parser: 'rules' };
}

// ------------------------------------------------------------------ replies in the customer's language
function translateMessages(text, lang) {
  const name = LANG_NAMES[lang] || lang;
  return [
    { role: 'system', content: 'You translate WhatsApp messages from a small Indian kirana shop to its customer. Translate the message into ' + name + '. ' +
      'Keep every number, rupee amount (₹), date, emoji, line break and bullet exactly as written, with Western digits 0-9. Keep shop names, person names and brand names. ' +
      'Keep any word written between *stars* exactly as it is, with the stars. Use simple, polite, everyday words. ' +
      'Answer with ONE JSON object and nothing else: {"text": "<the translation>"}' },
    { role: 'user', content: String(text) }
  ];
}
const toWesternDigits = (s) => String(s).replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x966)).replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x9E6))
  .replace(/[૦-૯]/g, (d) => String(d.charCodeAt(0) - 0xAE6)).replace(/[௦-௯]/g, (d) => String(d.charCodeAt(0) - 0xBE6));
const numbersIn = (s) => (toWesternDigits(s).replace(/(\d),(?=\d)/g, '$1').match(/\d+(\.\d+)?/g) || []).sort().join(' ');
/** A translation is used only when it keeps every number, every *starred* word and a sane length; else the Hinglish original goes. */
function checkTranslation(orig, j) {
  const t = j && typeof j.text === 'string' ? j.text.trim() : '';
  if (!t) throw new Error('empty translation');
  if (numbersIn(orig) !== numbersIn(t)) throw new Error('translation changed a number');
  const stars = (String(orig).match(/\*[^*\n]+\*/g) || []);
  if (stars.some((s) => t.indexOf(s) < 0)) throw new Error('translation changed a reply word');
  if (t.length > String(orig).length * 4 + 80) throw new Error('translation too long');
  return toWesternDigits(t);
}

module.exports = {
  LANG_NAMES, CUSTOMER_U, OWNER_U, KEYS, detectLang, normLang, replyLang, needsTranslation,
  customerMessages, ownerMessages, normalize, toCustomerIntent, toOwnerIntent, rulesUnderstand,
  translateMessages, checkTranslation, numbersIn, customerShots, ownerShots
};
