/**
 * Руки на токене: red (token-hands-cpred) — предметный модуль для Cyberpunk RED.
 * Foundry VTT v14, система cyberpunk-red-core.
 *
 * Вся отрисовка живёт в базовом модуле «Руки на токене» (token-hands).
 * Здесь только разбор того, что персонаж держит в руках, и передача слотов
 * базе. База начиная с v1.11.0 принимает произвольное число слотов массивом,
 * поэтому дополнительные киберруки и плечевые крепления отображаются все.
 *
 * Число рук берётся из системы: CPR Actor#getHands() учитывает базовые две
 * руки, бонусы `bonuses.hands`, искусственные плечевые крепления, киберруки
 * в них и потерянные конечности.
 */

const MODULE_ID = "token-hands-cpred";
const BASE_ID = "token-hands";
const SYSTEM_ID = "cyberpunk-red-core";

/** Типы актёров, у которых есть руки. */
const HAND_ACTOR_TYPES = new Set(["character", "mook"]);

/** Иконка свободной руки по умолчанию — штатная иконка безоружной атаки системы. */
const DEFAULT_UNARMED_ICON = "systems/cyberpunk-red-core/icons/compendium/weapons/unarmed.svg";

/** Запасные иконки, если у предмета нет картинки. */
const WEAPON_FALLBACKS = ["icons/svg/sword.svg", "icons/svg/item-bag.svg"];
const UNARMED_FALLBACKS = [
  DEFAULT_UNARMED_ICON,
  "icons/svg/combat.svg",
  "icons/svg/sword.svg",
];

let connected = false;

/* -------------------------------------------------------------------------- */
/*  Подключение к базе                                                        */
/* -------------------------------------------------------------------------- */

Hooks.once("init", () => {
  if (game.system?.id !== SYSTEM_ID) {
    console.warn(`[${MODULE_ID}] Нужна система Cyberpunk RED (${SYSTEM_ID}) — модуль отключается.`);
    return;
  }

  const base = game.modules.get(BASE_ID);
  if (!base?.active) {
    console.warn(`[${MODULE_ID}] Не включён базовый модуль «Руки на токене» (${BASE_ID}) — слотов не будет.`);
    if (game.user?.isGM) {
      ui.notifications.warn(game.i18n.localize("TOKEN-HANDS-CPRED.NeedsBase"));
    }
    return;
  }

  registerSettings();
  connectToBase();
});

// База может инициализироваться позже дочернего модуля: на ready пробуем ещё раз.
Hooks.once("ready", () => {
  if (game.system?.id !== SYSTEM_ID) return;
  if (!game.modules.get(BASE_ID)?.active) return;
  connectToBase();
  console.log(`[${MODULE_ID}] готов, версия ${game.modules.get(MODULE_ID)?.version}`);
});

function connectToBase() {
  if (connected) return true;

  const provider = {
    id: "cpred",
    resolveSlots,
    iconFallbacks: ["icons/svg/item-bag.svg"],
  };

  // Основной канал: публичный API базы (доступен уже на её init).
  if (globalThis.tokenHands?.register?.(provider)) {
    connected = true;
    console.info(`[${MODULE_ID}] подключён к базе «${BASE_ID}»`);
    return true;
  }

  // Запасной канал: хук, который база слушает на init.
  Hooks.call(`${BASE_ID}Register`, provider);

  const attached = globalThis.tokenHands?.providers?.().includes("cpred") === true;
  if (attached) {
    connected = true;
    console.info(`[${MODULE_ID}] подключён к базе «${BASE_ID}» через хук`);
  } else {
    console.warn(`[${MODULE_ID}] база не приняла провайдера — проверь, что ${BASE_ID} включён и обновлён.`);
  }
  return connected;
}

/* -------------------------------------------------------------------------- */
/*  Настройки                                                                 */
/* -------------------------------------------------------------------------- */

function registerSettings() {
  game.settings.register(MODULE_ID, "emptyHandsMode", {
    name: "TOKEN-HANDS-CPRED.Settings.EmptyHandsName",
    hint: "TOKEN-HANDS-CPRED.Settings.EmptyHandsHint",
    scope: "client",
    config: true,
    type: String,
    default: "auto",
    choices: {
      auto: "TOKEN-HANDS-CPRED.Settings.EmptyHandsAuto",
      always: "TOKEN-HANDS-CPRED.Settings.EmptyHandsAlways",
      never: "TOKEN-HANDS-CPRED.Settings.EmptyHandsNever",
    },
    onChange: () => globalThis.tokenHands?.refreshAllTokens?.(),
  });

  game.settings.register(MODULE_ID, "unarmedIcon", {
    name: "TOKEN-HANDS-CPRED.Settings.UnarmedIconName",
    hint: "TOKEN-HANDS-CPRED.Settings.UnarmedIconHint",
    scope: "client",
    config: true,
    type: String,
    default: DEFAULT_UNARMED_ICON,
    onChange: () => globalThis.tokenHands?.refreshAllTokens?.(),
  });
}

function emptyHandsMode() {
  try {
    return game.settings.get(MODULE_ID, "emptyHandsMode") ?? "auto";
  } catch {
    return "auto";
  }
}

function unarmedIcon() {
  try {
    return game.settings.get(MODULE_ID, "unarmedIcon") || DEFAULT_UNARMED_ICON;
  } catch {
    return DEFAULT_UNARMED_ICON;
  }
}

function unarmedLabel() {
  return game.i18n.localize("TOKEN-HANDS-CPRED.Unarmed");
}

/* -------------------------------------------------------------------------- */
/*  Разбор рук актёра                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Слоты рук для базы. null — актёр не наш или рук нет: база попробует
 * следующего провайдера и в итоге ничего не нарисует.
 *
 * @param {Actor} actor
 * @returns {Array<{key: string, img: string, name: string, item: Item|null, dim: boolean, fallbacks: string[]}>|null}
 */
function resolveSlots(actor) {
  if (!actor || !HAND_ACTOR_TYPES.has(actor.type)) return null;

  const handCount = getHandCount(actor);
  if (handCount <= 0) return null;

  const held = collectHeldItems(actor);
  // Руки нумеруются как в системе: 0 — правая, 1 — левая, 2+ — дополнительные.
  const hands = new Array(handCount).fill(null);

  // Двуручное оружие всегда занимает ведущую правую руку и левую (серая копия).
  // Остальные предметы идут только в дополнительные слоты и не сдвигают их.
  const primaryTwoHanded = held.find((item) => getRequiredHands(actor, item) >= 2) ?? null;

  if (primaryTwoHanded) {
    const required = Math.min(getRequiredHands(actor, primaryTwoHanded), handCount);
    for (let index = 0; index < required; index += 1) {
      hands[index] = { item: primaryTwoHanded, dim: index > 0 };
    }

    for (const item of held) {
      if (item === primaryTwoHanded) continue;
      assignToFreeHands(hands, item, getRequiredHands(actor, item), 2);
    }
  } else {
    for (const item of held) {
      assignToFreeHands(hands, item, getRequiredHands(actor, item), 0);
    }
  }

  // Свободные руки: «авто» показывает их только когда рук больше двух,
  // чтобы обычный персонаж с пустыми руками не загромождал токен.
  const mode = emptyHandsMode();
  const showEmpty = mode === "always" || (mode === "auto" && handCount > 2);
  if (showEmpty) {
    for (let index = 0; index < handCount; index += 1) {
      if (!hands[index]) hands[index] = { item: null, dim: false, unarmed: true };
    }
  }

  // Порядок отрисовки: слева направо, правая рука всегда крайняя справа.
  const order = [];
  if (handCount <= 2) {
    for (let index = handCount - 1; index >= 0; index -= 1) order.push(index);
  } else {
    for (let index = handCount - 1; index >= 2; index -= 1) order.push(index);
    order.push(1, 0);
  }

  const slots = [];
  for (const handIndex of order) {
    const entry = hands[handIndex];
    if (!entry) continue;
    const key = handKey(handIndex);
    slots.push(entry.unarmed
      ? makeUnarmedSlot(key)
      : makeItemSlot(entry.item, entry.dim, key));
  }

  return slots.length > 0 ? slots : null;
}

/** Занять предметом свободные руки начиная с указанного индекса. */
function assignToFreeHands(hands, item, required, startIndex) {
  let assigned = 0;
  for (let index = startIndex; index < hands.length && assigned < required; index += 1) {
    if (hands[index] !== null) continue;
    hands[index] = { item, dim: assigned > 0 };
    assigned += 1;
  }
  return assigned;
}

/** Ключ слота: 0 — правая рука, 1 — левая, дальше дополнительные. */
function handKey(index) {
  if (index === 0) return "right";
  if (index === 1) return "left";
  return `hand${index}`;
}

/** Сколько функциональных рук у актёра по правилам системы. */
function getHandCount(actor) {
  try {
    const value = typeof actor.getHands === "function"
      ? actor.getHands()
      : (typeof actor._getHands === "function" ? actor._getHands() : null);
    const count = Number(value);
    if (Number.isFinite(count)) return Math.max(0, Math.floor(count));
  } catch (err) {
    console.warn(`[${MODULE_ID}] не удалось получить число рук`, err);
  }

  // Резерв: базовые две руки плюс бонусы, если метод системы недоступен.
  const bonus = Number(actor?.bonuses?.hands ?? 0);
  return Math.max(0, 2 + (Number.isFinite(bonus) ? bonus : 0));
}

/**
 * Что актёр держит в руках: equipped-оружие, установленная кибернетика-оружие
 * и щиты. Порядок: оружие, затем щиты; внутри — по порядку в листе.
 */
function collectHeldItems(actor) {
  const items = [];
  const seen = new Set();

  const add = (item) => {
    if (!item?.id || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };

  // Основной источник — системный геттер: он уже учитывает equipped-оружие,
  // установленную кибернетику и вторичное оружие в апгрейдах.
  let equipped = [];
  try {
    equipped = Array.isArray(actor.system?.weapons?.equipped)
      ? actor.system.weapons.equipped
      : [];
  } catch (err) {
    console.debug(`[${MODULE_ID}] system.weapons.equipped недоступен`, err);
  }

  for (const item of equipped) {
    if (!item || item.type === "itemUpgrade") continue; // вторичное оружие не рисуем отдельным слотом
    add(item);
  }

  // Резервный проход: если геттер системы пуст или недоступен.
  for (const item of actor.items ?? []) {
    if (item.type === "weapon" && item.system?.equipped === "equipped") add(item);
    if (item.type === "cyberware" && item.system?.isWeapon && item.system?.isInstalledInActor) add(item);
  }

  // Щиты — это armor с флагом isShield.
  for (const item of actor.items ?? []) {
    if (item.type === "armor" && item.system?.isShield && item.system?.equipped === "equipped") add(item);
  }

  const priority = (item) => {
    if (item.type === "armor") return 1;
    return 0;
  };
  items.sort((a, b) => (priority(a) - priority(b))
    || ((Number(a.sort) || 0) - (Number(b.sort) || 0))
    || String(a.name ?? "").localeCompare(String(b.name ?? "")));

  return items;
}

/** Сколько рук занимает предмет. */
function getRequiredHands(actor, item) {
  if (item.type === "armor" && item.system?.isShield) return 1;

  if (item.type === "weapon" && typeof actor.getRequiredWeaponHands === "function") {
    try {
      const value = Number(actor.getRequiredWeaponHands(item));
      if (Number.isFinite(value) && value > 0) return Math.floor(value);
    } catch (err) {
      console.debug(`[${MODULE_ID}] getRequiredWeaponHands не сработал`, err);
    }
  }

  const raw = Number(item.system?.handsReq);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);

  // Кибероружие обычно не указывает handsReq — считаем одну руку.
  return 1;
}

function makeItemSlot(item, dim, key) {
  return {
    key,
    img: item.img || WEAPON_FALLBACKS[0],
    name: item.name ?? "",
    item,
    dim: !!dim,
    fallbacks: [...WEAPON_FALLBACKS],
  };
}

function makeUnarmedSlot(key) {
  return {
    key,
    img: unarmedIcon(),
    name: unarmedLabel(),
    item: null,
    dim: false,
    fallbacks: [...UNARMED_FALLBACKS],
  };
}

/* -------------------------------------------------------------------------- */
/*  Диагностика                                                               */
/* -------------------------------------------------------------------------- */

Hooks.once("ready", () => {
  if (game.system?.id !== SYSTEM_ID) return;
  globalThis.tokenHandsCpred = {
    resolveSlots,
    collectHeldItems,
    getHandCount,
    getRequiredHands,
    emptyHandsMode,
    unarmedIcon,
  };
});
