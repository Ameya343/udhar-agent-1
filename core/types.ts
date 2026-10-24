// The shapes of one shop's khata (the JSON state object saved per shop) and of the intents the agent works with.
// Types only: nothing here is emitted, so core/agent-core.ts stays dependency-free for the browser build.
//
// The khata is plain JSON that grew over time: most fields are optional, because an older saved khata may not have
// them yet, and the code adds them on first use (state.prices, state.orders, ...). Dates are 'YYYY-MM-DD' strings,
// timestamps are milliseconds, money is rupees as a number.

/** 'YYYY-MM-DD' */
export type IsoDate = string;

export type TxnType = 'credit' | 'payment';
/** Where an item line's price came from. */
export type LineFrom = 'spoken' | 'memory' | 'derived' | 'extra' | 'variant';

export interface Shop {
  id?: string;
  name: string;
  owner: string;
  upiId: string;
  city?: string;
  defaultDays: number;
  tone?: string;
  /** one entry above this many rupees is asked about first (default 100000) */
  maxEntry?: number;
}

/** One bill / list / order line: "Cheeni 2 kilo = ₹90". */
export interface Line {
  name: string;
  key?: string;
  qty: number | null;
  unit: string | null;
  price: number | null;
  from?: LineFrom | null;
  /** price as a rate for one unit ("2 kg chawal 60 ka"), the total is price * qty */
  perRate?: number;
  /** remembered rate used for this line, and its unit */
  rate?: number;
  rateUnit?: string;
  /** "120 ka doodh": money spent, not a rate to learn */
  amountOnly?: boolean;
  // parser scratch fields, removed before a line is saved
  bare?: boolean;
  per?: boolean;
}

/** parseLines output before the lines get names. */
export interface RawLine {
  words: number[];
  qty: number | null;
  unit: string | null;
  price: number | null;
  bare?: boolean;
  per?: boolean;
}

export interface LineParse {
  lines: Line[];
  total: number | null;
  loose: number[];
}

export interface Customer {
  id: string;
  name: string;
  key: string;
  phone: string | null;
  vpas: string[];
  dueDate: IsoDate | null;
  lastReminder: IsoDate | null;
  reminderLevel: number;
  createdAt?: IsoDate;
  removed?: boolean;
  removedAt?: string;
  removedToldAt?: string;
  rejoinDeclined?: IsoDate;
  /** a number that wrote first and has no khata yet */
  guest?: boolean;
  /** wrote to the shop's WhatsApp (only then is it messaged) */
  wa?: boolean;
  /** the WhatsApp address with country code, when longer than the 10 digits */
  waTo?: string;
  /** ISO time the customer asked for no more messages */
  optedOut?: string;
  lang?: string | null;
  disputed?: boolean;
  vouch?: Vouch;
  limit?: number;
  /** short names the owner confirmed for this khata ("Ramesh" for Ramesh Gupta) */
  aliases?: string[];
  /** the due date for which the owner was told the three reminders are done (KAN-89) */
  handedOff?: IsoDate | null;
  limitSince?: IsoDate;
  limitCap?: number;
  payday?: number;
  waLimits?: WaLimits;
  statementOk?: { date: IsoDate; balance: number };
  statementAuto?: boolean;
  demo?: boolean;
}

export interface Vouch {
  by: string;
  date: IsoDate;
  toldFor?: IsoDate | null;
  declined?: IsoDate;
}

/** Last time (ms) each kind of message went to a customer, for the per-customer limits. */
export interface WaLimits {
  menu?: number;
  hi?: number;
  relay?: number;
  abuse?: number;
  pay?: number;
  relayText?: string;
}

export interface Txn {
  id: string;
  custId: string;
  type: TxnType;
  amount: number;
  items?: string;
  lines?: Line[];
  date: IsoDate;
  dueDate?: IsoDate | null;
  note?: string;
  source?: string;
  parser?: string;
  via?: string;
  voided?: boolean;
  voidReason?: string;
  matchedBy?: string;
  adjust?: boolean;
  spokenTotal?: number | null;
  edited?: IsoDate;
  fixedFrom?: number;
  movedFrom?: string;
  custOk?: IsoDate;
  custAuto?: boolean;
  custWrong?: IsoDate;
  /** "Ramesh ka udhaar maaf": a write-off, not money received */
  writeOff?: boolean;
}

export interface Message {
  id: string;
  to: string;
  from: string;
  text: string;
  date: IsoDate;
  ts: number;
  source?: string;
  kind?: string;
  /** voice note length in seconds (owner messages) */
  dur?: number;
  parser?: string;
  // meta that some agent messages carry
  txnId?: string;
  list?: boolean;
  level?: number;
  upi?: string;
  amount?: number;
  balance?: number;
  orderId?: string;
  claimId?: string;
  claimIds?: string[];
  wsOrder?: string;
  wsId?: string;
  /** the customer's answer to an entry check / statement */
  answer?: 'ok' | 'wrong' | 'gone' | 'auto';
  /** set by the server when the text was translated */
  textOrig?: string;
  lang?: string | null;
}

export type MessageMeta = Partial<Omit<Message, 'id' | 'to' | 'from' | 'text' | 'date' | 'ts'>>;

export interface LogEntry {
  date: IsoDate;
  ts: number;
  kind: string;
  text: string;
}

export interface DisputeNote {
  text: string;
  amount: number | null;
  english: string;
  intent: string;
  at: number;
}

/** A cash claim, a Galla Mic entry or a customer's "galat hai", waiting for the owner. */
export interface CashClaim {
  id: string;
  custId: string;
  amount: number;
  date: IsoDate;
  status: 'pending' | 'confirmed' | 'disputed' | 'dropped' | 'kept' | 'fixed';
  type?: 'credit' | 'check';
  origin?: string;
  what?: string;
  txnId?: string | null;
  label?: string;
  at?: number;
  resolvedOn?: IsoDate;
  items?: string;
  heard?: string;
  why?: string;
  notes?: DisputeNote[];
}

export interface Price {
  name: string;
  rate: number;
  unit: string;
  date: IsoDate;
  traderRate?: number;
}

export interface Supply {
  id: string;
  key: string;
  name: string;
  amount: number;
  paid: number;
  date: IsoDate;
  dueDate: IsoDate;
  lines?: Line[];
  orderId?: string;
}

export interface SupplierPay {
  key: string;
  name: string;
  amount: number;
  date: IsoDate;
}

export interface Wholesaler {
  id: string;
  key: string;
  name: string;
  phone: string | null;
  items: string[];
  wa: boolean;
  waTo?: string;
  /** what kind of goods they sell (Kirana, Dairy, ...); set by the owner on the dashboard, else guessed from items */
  category?: string;
}

export interface WsLine {
  name: string;
  key?: string;
  qty: number | null;
  unit: string | null;
}

export interface WsOrder {
  id: string;
  wsId: string;
  name: string;
  lines: WsLine[];
  date: IsoDate;
  status: 'draft' | 'sent' | 'unsent' | 'cancelled' | 'delivered';
  bill: number | null;
  supplyId: string | null;
  why?: string;
  sentAt?: IsoDate;
  reply?: string;
  replyDate?: IsoDate;
}

export interface Order {
  id: string;
  custId: string;
  lines: Line[];
  amount: number;
  date: IsoDate;
  status: 'ask' | 'owner' | 'done' | 'rejected';
  mode: 'udhaar' | 'cash' | null;
  addTo?: string;
  txnId?: string;
}

/** A question waiting for the owner's ok / nahi (the first one is what "ok" answers). */
export interface OwnerAsk {
  type: 'ws-order' | 'ws-bill' | 'vouch' | 'rejoin' | 'guest' | 'order';
  orderIds?: string[];
  orderId?: string;
  custId?: string;
  /** already shown once under another reply */
  reshown?: boolean;
}

export interface Consent {
  status: 'none' | 'requested' | 'granted' | 'denied' | 'revoked' | 'expired';
  lender?: string;
  purpose?: string;
  requestedAt?: IsoDate;
  days?: number;
  decidedAt?: IsoDate;
  expires?: IsoDate;
}

export interface UpiInfo {
  amount: number | null;
  vpa: string | null;
  payerName: string | null;
  tag: string | null;
  ref: string | null;
  credited: boolean;
  /** the owner's own outgoing payment ("debited ... to PAPPU", "sent to PAPPU"): never a customer's jama (KAN-104) */
  outgoing?: boolean;
  payeeName?: string | null;
  /** rounded from paise ("Rs 500.75" -> 501), told to the owner (KAN-105) */
  roundedFrom?: number;
  raw?: string;
}

/** The one question the agent is waiting on (a number, a rate, haan / nahi, a wholesaler). */
export interface Pending {
  type: 'action' | 'counter' | 'confirm' | 'upi' | 'list-rate' | 'ws-which';
  options: string[];
  action?: OwnerIntent;
  allowNew?: boolean;
  what?: 'void' | 'fix' | 'pay' | 'new-cust' | 'loose-cust' | 'repeat';
  txnId?: string;
  custId?: string;
  to?: number;
  text?: string;
  source?: string;
  upi?: UpiInfo;
  ask?: number;
  lines?: WsLine[];
}

/** One shop's whole khata. */
export interface State {
  version: number;
  shop: Shop;
  today: IsoDate;
  seqs: Record<string, number>;
  customers: Customer[];
  txns: Txn[];
  messages: Message[];
  log: LogEntry[];
  pending: Pending | null;
  seenUpiRefs: string[];
  lastAction: { txnId: string } | null;
  cashClaims: CashClaim[];
  eveningSentFor: IsoDate | null;
  prices?: Record<string, Price>;
  supplies?: Supply[];
  supplierPays?: SupplierPay[];
  wholesalers?: Wholesaler[];
  wsOrders?: WsOrder[];
  orders?: Order[];
  ownerAsks?: OwnerAsk[];
  parkedAsks?: OwnerAsk[];
  consents?: Record<string, Consent>;
  lastWrite?: { key: string; ts: number; day?: IsoDate };
  statementFor?: string;
  // set by the server
  ownerPhone?: string;
  wsSeeded?: boolean;
  waLastIn?: Record<string, number>;
  waAsked?: string;
  paySecret?: string;
  /** "sabko kal yaad dila dena": the day the owner asked for reminders to everyone */
  remindAllOn?: IsoDate;
}

// ------------------------------------------------------------------ intents

/** The model's own reading of an owner message (core/understand.ts normalize()). */
export interface Understanding {
  lang: string | null;
  english: string;
  relevant: boolean | null;
  reason: string;
  intent: string;
  items: UnderstoodItem[];
  amount: number | null;
  person: string;
  phone: string;
  dueDate: string;
  method: string;
  canon: string;
  confidence: number | null;
  ask: string;
  entries: UnderstoodEntry[];
}
export interface UnderstoodItem {
  name: string;
  qty: number | null;
  unit: string | null;
  price: number | null;
  loose?: boolean;
}
export interface UnderstoodEntry {
  person: string;
  amount: number | null;
  type: 'udhaar' | 'jama';
}

/**
 * What the owner said, as parseOwnerMessage (rules) or intentFromLlm (the model) gives it; applyIntent acts on it.
 * List, counter and need-rate readings use the same object with their extra fields.
 */
export interface OwnerIntent {
  intent: string;
  name?: string | null;
  nameKey?: string | null;
  amount?: number | null;
  items?: string;
  lines?: Line[] | null;
  lineParse?: LineParse;
  dueDate?: IsoDate | null;
  phone?: string | null;
  raw?: string;
  parser?: string;
  source?: string;
  choice?: number;
  adjust?: boolean;
  confirmed?: boolean;
  create?: boolean;
  matches?: Customer[];
  missing?: string[];
  ask?: string | null;
  canon?: string | null;
  counter?: { total: number | null; heard: string };
  list?: { total: number | null; sum?: number };
  edit?: { txnId: string; op: string };
  /** a huge amount the owner already confirmed */
  bigOk?: boolean;
  /** an item rate far from the remembered one, already confirmed (KAN-106) */
  rateOk?: boolean;
  /** "500 diye the kal": the day the money came */
  paidOn?: IsoDate;
  /** a promised day that does not exist or is out of reach, asked instead of written (KAN-110) */
  dueBad?: string;
  /** "udhaar maaf": a write-off */
  writeOff?: boolean;
  /** "10% kam karo" */
  percent?: number;
  /** the amount as said, when it had paise and was rounded to whole rupees (KAN-91) */
  roundedFrom?: number;
  /** never itemized into bill lines (promises, questions, notes) */
  noBill?: boolean;
  /** the digits of a phone number that is not 10 digits */
  badPhone?: string;
  // the model's extras (core/understand.ts toOwnerIntent, server/brain.ts)
  llmIntent?: string;
  lang?: string | null;
  english?: string;
  relevant?: boolean | null;
  confidence?: number | null;
  provider?: string;
  ms?: number;
  u?: Understanding;
}

/** "Sharma ji ka 340 nahi 430 tha", "Sharma ji ki entry cancel", "nahi 340 hi tha". */
export interface FixIntent {
  /** the owner already said haan: void without asking again */
  sure?: boolean;
  intent: 'fix';
  name?: string | null;
  nameKey?: string | null;
  matches?: Customer[];
  from?: number | null;
  to?: number | null;
  amount?: number | null;
  ask?: boolean;
  many?: string[];
  nameless?: boolean;
  raw?: string;
}

/** A known person named in a message. */
export interface Person {
  i: number;
  end: number;
  name: string;
  key: string;
  matches: Customer[];
}

export interface SwapIntent {
  intent: 'swap';
  from: Person;
  to: Person;
  raw: string;
}

export interface MultiPair {
  name: string;
  key: string;
  matches: Customer[];
  amount: number;
  type: TxnType | null;
  unknown?: boolean;
  lines?: Line[];
  items?: string;
  start?: number;
  again?: boolean;
}

export interface MultiIntent {
  intent: 'multi';
  type?: TxnType;
  /** the entries; absent when ask is set */
  pairs?: MultiPair[];
  ask?: boolean;
  /** the people to ask about, when ask is set */
  names?: string[];
  raw: string;
  parser?: string;
}

export interface ItemRemoveIntent {
  intent: 'item-remove';
  want: string[];
  raw: string;
}

/** An edit of a list already written ("Krish ki list mein 2 Maggi jod do"). */
export interface ListEdit {
  name: string;
  nameKey: string;
  op: 'add' | 'remove' | 'price' | 'replace';
  body: string;
  price: number | null;
  raw: string;
}

/** A customer's list read out by the owner, while it is being priced. */
export interface ListIntent extends OwnerIntent {
  list: { total: number | null; sum?: number };
}

/** The intent a handled owner message reports back (for the server and the tests). */
export type HandledIntent =
  | OwnerIntent
  | FixIntent
  | SwapIntent
  | MultiIntent
  | ItemRemoveIntent;

export interface OwnerResult {
  intent: HandledIntent;
  messages: Message[];
}

/** A customer's message as the rules or the model read it (handleCustomerMessage's opts.intent). */
export interface CustomerIntent {
  intent: string;
  parser: string;
  method?: string;
  amount?: number | null;
  // the model's extras (core/understand.ts toCustomerIntent)
  llmIntent?: string;
  add?: boolean;
  udhaar?: boolean;
  items?: UnderstoodItem[];
  lang?: string | null;
  english?: string;
  relevant?: boolean | null;
  reason?: string;
  confidence?: number | null;
  ask?: string | null;
  provider?: string;
  ms?: number;
  u?: Understanding;
}

/** A supplier message: new maal udhaar, a payment, one supplier's hisaab, or the list. */
export interface SupplierParse {
  kind: 'new' | 'paid' | 'ask' | 'list';
  key?: string;
  name?: string;
  amount?: number | null;
  dueDate?: IsoDate;
  lines?: Line[];
}

export interface WsGroup {
  wsId: string;
  lines: WsLine[];
}

/** A wholesale message from the owner. */
export interface WholesaleParse {
  kind: 'phone' | 'items' | 'list' | 'order' | 'which' | 'arrived';
  wsId?: string;
  name?: string;
  phone?: string;
  items?: string[];
  groups?: WsGroup[];
  lines?: WsLine[];
  unknown?: WsLine[];
  ask?: string[];
  orderId?: string | null;
  amount?: number | null;
  paid?: boolean;
}

/** One action's arguments from the web page or the server (runAction). */
export interface ActionArgs {
  text?: unknown;
  source?: unknown;
  intent?: unknown;
  dur?: unknown;
  custId?: unknown;
  now?: unknown;
  claimId?: unknown;
  ok?: unknown;
  wsId?: unknown;
  orderId?: unknown;
  udhaar?: unknown;
  yes?: unknown;
  msgId?: unknown;
  heard?: unknown;
  orderIds?: unknown;
  category?: unknown;
  [key: string]: unknown;
}

/** The tokens of one message: the words as written (display), normalised (norm), and norm joined with spaces around. */
export interface Tokens {
  display: string[];
  norm: string[];
  text: string;
}
