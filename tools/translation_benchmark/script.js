const LANGUAGE_DATA = {
  en: {
    name: "英语",
    native: "English",
    lang: "en",
    samples: [
      ["短词 / UI", "Raw"],
      ["新闻标题", "The world will again wait to see whether he folds when political costs pile up."],
      ["习语", "The proposal is not a silver bullet, but it could buy policymakers some breathing room."],
      ["技术说明", "The feature processes photos on the device, so the originals never leave your phone."],
      ["财经语境", "The bank wrote down the value of the asset after higher-for-longer rates squeezed demand."],
      ["歧义 / 语气", "She said the deal was still on the table, although neither side appeared ready to blink."],
      ["长句", "While the update fixes the bug that caused some users to be signed out unexpectedly, the company says accounts created before June may still need to verify their recovery email the next time they log in."],
      ["专名 / 法律", "Tiananmen vigil organizers found guilty of inciting subversion in Hong Kong."],
    ],
  },
  ja: {
    name: "日语",
    native: "日本語",
    lang: "ja",
    samples: [
      ["短词 / UI", "設定"],
      ["新闻标题", "政府は追加対策を打ち出したが、市場の反応は限定的だった。"],
      ["习语", "雨降って地固まる。"],
      ["技术说明", "この機能は端末内で処理されるため、元の写真がサーバーに送信されることはありません。"],
      ["口语表达", "彼は『話がうますぎる』と警戒し、契約書をもう一度読み直した。"],
      ["文化语境", "空気を読むことが求められる場面でも、必要な異論はきちんと伝えるべきだ。"],
      ["长句", "新しい制度は手続きを簡素化する一方で、申請時期によって必要書類が異なるため、利用者には事前確認が求められている。"],
      ["歧义", "生で見るのと画面越しに見るのとでは、受ける印象がまるで違う。"],
    ],
  },
  ko: {
    name: "韩语",
    native: "한국어",
    lang: "ko",
    samples: [
      ["短词 / UI", "설정"],
      ["新闻标题", "정부는 추가 대책을 내놨지만 시장 반응은 미지근했다."],
      ["习语", "발등에 불이 떨어지고 나서야 대책을 찾기 시작했다."],
      ["技术说明", "이 기능은 기기에서 직접 처리되므로 원본 사진이 서버로 전송되지 않습니다."],
      ["口语表达", "그는 '말처럼 쉬운 일은 아니다'라며 선을 그었다."],
      ["文化语境", "눈치가 빠른 사람이라도 모든 분위기를 정확히 읽을 수 있는 것은 아니다."],
      ["长句", "업데이트는 로그인 오류를 해결했지만 지난달 이전에 만들어진 계정은 다음 접속 때 복구 이메일을 다시 확인해야 할 수도 있다."],
      ["歧义", "그 회사는 비판이 커지자 결국 한발 물러섰다."],
    ],
  },
  fr: {
    name: "法语",
    native: "Français",
    lang: "fr",
    samples: [
      ["短词 / UI", "Paramètres"],
      ["新闻标题", "Le gouvernement a présenté de nouvelles mesures, mais les marchés sont restés prudents."],
      ["习语", "Ce n'est pas la mer à boire, mais il faudra s'y mettre sérieusement."],
      ["技术说明", "L'application traite les photos sur l'appareil afin que les originaux ne quittent jamais votre téléphone."],
      ["口语表达", "Après plusieurs semaines de tension, il a fini par mettre de l'eau dans son vin."],
      ["财经语境", "La banque a revu la valeur de l'actif à la baisse après le recul de la demande."],
      ["长句", "Même si la mise à jour corrige le problème principal, certains utilisateurs devront encore vérifier leur adresse de récupération lors de leur prochaine connexion."],
      ["歧义", "Le ministre a assuré que la porte restait ouverte, sans préciser jusqu'à quand."],
    ],
  },
  de: {
    name: "德语",
    native: "Deutsch",
    lang: "de",
    samples: [
      ["短词 / UI", "Einstellungen"],
      ["新闻标题", "Die Regierung legte weitere Maßnahmen vor, doch die Märkte reagierten verhalten."],
      ["习语", "Das ist nicht das Gelbe vom Ei, aber für den Moment reicht es."],
      ["技术说明", "Die Daten werden ausschließlich auf dem Gerät verarbeitet und nicht an den Server übertragen."],
      ["口语表达", "Er wollte sich nicht zu weit aus dem Fenster lehnen und vermied eine klare Prognose."],
      ["财经语境", "Höhere Zinsen setzten die Nachfrage unter Druck und zwangen die Bank zu einer Abschreibung."],
      ["长句", "Obwohl das Update den Fehler behebt, können ältere Konten bei der nächsten Anmeldung weiterhin zur Bestätigung ihrer Wiederherstellungsadresse aufgefordert werden."],
      ["歧义", "Der Vorstand ließ offen, ob die Entscheidung endgültig ist."],
    ],
  },
  es: {
    name: "西班牙语",
    native: "Español",
    lang: "es",
    samples: [
      ["短词 / UI", "Configuración"],
      ["新闻标题", "El Gobierno anunció nuevas medidas, pero los mercados reaccionaron con cautela."],
      ["习语", "No es para tirar cohetes, pero al menos nos da un poco de margen."],
      ["技术说明", "La aplicación procesa las fotos en el dispositivo para que los originales nunca salgan del teléfono."],
      ["口语表达", "La empresa dio marcha atrás después de que aumentaran las críticas."],
      ["财经语境", "El banco redujo el valor del activo después de que los tipos altos frenaran la demanda."],
      ["长句", "Aunque la actualización corrige el fallo principal, las cuentas creadas antes de junio todavía pueden tener que verificar su correo de recuperación al volver a iniciar sesión."],
      ["歧义", "El ministro dijo que la oferta seguía sobre la mesa, pero evitó comprometerse con una fecha."],
    ],
  },
};

const languageSelect = document.querySelector("#languageSelect");
const languageTabs = document.querySelector("#languageTabs");
const testList = document.querySelector("#testList");
const activeLanguageLabel = document.querySelector("#activeLanguageLabel");
const copyButton = document.querySelector("#copyButton");
const resetButton = document.querySelector("#resetButton");
const toast = document.querySelector("#toast");

let activeLanguage = new URLSearchParams(window.location.search).get("lang");
if (!LANGUAGE_DATA[activeLanguage]) activeLanguage = "en";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTabs() {
  languageTabs.innerHTML = Object.entries(LANGUAGE_DATA)
    .map(([key, item]) => `<button type="button" data-lang="${key}" aria-pressed="${key === activeLanguage}">${item.name}<span class="tab-native"> · ${item.native}</span></button>`)
    .join("");
}

function renderSamples() {
  const data = LANGUAGE_DATA[activeLanguage];
  languageSelect.value = activeLanguage;
  activeLanguageLabel.textContent = `${data.name} · ${data.native} · ${data.samples.length} 条固定样本`;
  testList.innerHTML = data.samples
    .map(([category, text], index) => `
      <li class="test-item">
        <span class="test-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
        <div class="test-copy"><p lang="${data.lang}" data-source-text="true">${escapeHtml(text)}</p></div>
        <div class="test-meta"><span class="category-badge">${category}</span></div>
      </li>`)
    .join("");
}

function syncUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("lang", activeLanguage);
  history.replaceState(null, "", url);
}

function setLanguage(lang) {
  if (!LANGUAGE_DATA[lang]) return;
  activeLanguage = lang;
  renderTabs();
  renderSamples();
  syncUrl();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

languageTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-lang]");
  if (button) setLanguage(button.dataset.lang);
});

languageSelect.addEventListener("change", () => setLanguage(languageSelect.value));

resetButton.addEventListener("click", () => {
  renderSamples();
  showToast("已恢复当前语言原文");
});

copyButton.addEventListener("click", async () => {
  const data = LANGUAGE_DATA[activeLanguage];
  const text = data.samples.map((sample, index) => `${index + 1}. ${sample[1]}`).join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    showToast("已复制当前语言全部原文");
  } catch {
    showToast("复制失败，请手动选择文本");
  }
});

renderTabs();
renderSamples();
