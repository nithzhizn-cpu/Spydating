const tg = window.Telegram.WebApp || null;

const state = {
  tgId: null,
  me: null,
  swipeDeck: [],
  swipeIndex: 0,
  partners: [],
  activeChatPartner: null,
  isDragging: false,
  dragStartX: 0,
  dragCurrentX: 0,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function apiUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, v);
    }
  });
  return url.toString();
}

async function apiGet(path, params = {}) {
  const res = await fetch(apiUrl(path, params));
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    body,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === "tab-" + name)
  );
}

// ---------- TELEGRAM INIT ---------- //

async function initTelegram() {
  if (tg) {
    tg.ready();
    tg.expand?.();
  }

  const init = tg?.initDataUnsafe;
  let tgId, name, username;

  if (init?.user) {
    tgId = String(init.user.id);
    name = init.user.first_name + (init.user.last_name ? " " + init.user.last_name : "");
    username = init.user.username;
  } else {
    // debug mode in browser
    tgId = "debug-" + Math.floor(Math.random() * 1e6);
    name = "Debug User";
    username = "debug";
  }

  state.tgId = tgId;

  const fd = new FormData();
  fd.append("tg_id", tgId);
  if (name) fd.append("name", name);
  if (username) fd.append("username", username);

  const resp = await apiPost("/api/tg-login", fd);
  state.me = resp.user;

  if (state.me.is_premium) {
    $("#premium-badge").classList.remove("hidden");
  }

  await loadProfile();
  await loadSwipeDeck();
  await loadPartners();

  startChatPolling();
}

// ---------- PROFILE ---------- //

async function loadProfile() {
  const data = await apiGet("/api/me", { tg_id: state.tgId });
  state.me = data;

  $("#pf-name").value = data.display_name || "";
  $("#pf-age").value = data.age || "";
  $("#pf-city").value = data.city || "";
  $("#pf-gender").value = data.gender || "";
  $("#pf-looking").value = data.looking_for || "all";
  $("#pf-interests").value = data.interests || "";
  $("#pf-bio").value = data.bio || "";

  $("#toggle-invisible").checked = !!data.invisible_mode;

  if (data.photo) {
    $("#avatar-preview").src = data.photo;
  } else {
    $("#avatar-preview").src =
      "https://via.placeholder.com/200x200/020617/4b5563?text=No+Photo";
  }
}

async function saveProfile(withPhoto = false) {
  const fd = new FormData();
  fd.append("tg_id", state.tgId);
  fd.append("display_name", $("#pf-name").value.trim());
  if ($("#pf-age").value) fd.append("age", $("#pf-age").value);
  fd.append("city", $("#pf-city").value.trim());
  fd.append("gender", $("#pf-gender").value);
  fd.append("looking_for", $("#pf-looking").value);
  fd.append("interests", $("#pf-interests").value.trim());
  fd.append("bio", $("#pf-bio").value.trim());
  fd.append("invisible_mode", $("#toggle-invisible").checked ? "true" : "false");

  if (withPhoto) {
    const fileInput = $("#avatar-file");
    if (fileInput.files[0]) {
      fd.append("file", fileInput.files[0]);
    }
  }

  await apiPost("/api/me/update", fd);
  $("#pf-status").textContent = "Профіль збережено";
  setTimeout(() => ($("#pf-status").textContent = ""), 2000);
  await loadProfile();
  await loadSwipeDeck();
}

// ---------- PREMIUM ---------- //

async function togglePremium() {
  const newVal = !(state.me?.is_premium);
  const fd = new FormData();
  fd.append("tg_id", state.tgId);
  fd.append("value", newVal ? "true" : "false");
  const resp = await apiPost("/api/premium/set", fd);
  state.me.is_premium = resp.is_premium;
  if (state.me.is_premium) {
    $("#premium-badge").classList.remove("hidden");
  } else {
    $("#premium-badge").classList.add("hidden");
  }
}

// ---------- SWIPE DECK ---------- //

function buildCard(user) {
  const card = document.createElement("div");
  card.className = "swipe-card";
  card.dataset.userId = user.id;

  card.innerHTML = `
    <div class="swipe-card-bg">
      <img src="${
        user.photo ||
        "https://via.placeholder.com/400x300/020617/4b5563?text=No+Photo"
      }" alt="">
      <div class="swipe-card-overlay"></div>
    </div>
    <div class="swipe-card-content">
      <div class="swipe-name-row">
        <div>
          <span class="swipe-name">${user.display_name || "Користувач"}</span>
          ${
            user.age
              ? `<span class="swipe-age">${user.age}</span>`
              : ""
          }
        </div>
        <button class="btn-ghost small btn-view-profile">Детальніше</button>
      </div>
      <div class="swipe-city">${user.city || "Місто не вказано"}</div>
      <div class="swipe-badges">
        ${
          user.liked_me
            ? '<span class="badge-mini badge-like-me">Лайкнув(ла) тебе</span>'
            : ""
        }
        ${
          user.is_match
            ? '<span class="badge-mini badge-match">Match ❤️</span>'
            : ""
        }
      </div>
      <div class="swipe-bio">${user.bio || "<i>Без опису</i>"}</div>
      ${
        user.interests
          ? `<div class="swipe-interests">Інтереси: ${user.interests}</div>`
          : ""
      }
    </div>
  `;

  const btnView = card.querySelector(".btn-view-profile");
  btnView.addEventListener("click", (e) => {
    e.stopPropagation();
    openProfileModal(user);
  });

  // drag/swipe handlers
  card.addEventListener("pointerdown", (e) => {
    state.isDragging = true;
    state.dragStartX = e.clientX;
    state.dragCurrentX = e.clientX;
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!state.isDragging) return;
    state.dragCurrentX = e.clientX;
    const dx = state.dragCurrentX - state.dragStartX;
    const rotation = dx / 15;
    card.style.transform = `translateX(${dx}px) rotate(${rotation}deg)`;
  });

  card.addEventListener("pointerup", (e) => {
    if (!state.isDragging) return;
    state.isDragging = false;
    const dx = state.dragCurrentX - state.dragStartX;
    const threshold = 80;
    if (dx > threshold) {
      handleLike("like");
    } else if (dx < -threshold) {
      handleLike("skip");
    } else {
      card.style.transform = "";
    }
  });

  return card;
}

function renderSwipeDeck() {
  const stack = $("#swipe-stack");
  stack.innerHTML = "";

  if (!state.swipeDeck.length || state.swipeIndex >= state.swipeDeck.length) {
    $("#swipe-empty").classList.remove("hidden");
    return;
  }
  $("#swipe-empty").classList.add("hidden");

  const remaining = state.swipeDeck.slice(state.swipeIndex);
  remaining.reverse().forEach((user, idx) => {
    const card = buildCard(user);
    card.style.zIndex = String(10 + idx);
    const scale = 1 - idx * 0.03;
    card.style.transform = `scale(${scale}) translateY(${idx * 4}px)`;
    stack.appendChild(card);
  });
}

async function loadSwipeDeck() {
  const gender = $("#swipe-gender").value;
  const city = $("#swipe-city").value.trim();
  const data = await apiGet("/api/search", {
    tg_id: state.tgId,
    gender,
    city,
  });
  state.swipeDeck = data.users || [];
  state.swipeIndex = 0;
  renderSwipeDeck();
}

// ---- like / superlike / skip ---- //

async function handleLike(type) {
  if (!state.swipeDeck.length || state.swipeIndex >= state.swipeDeck.length) {
    return;
  }
  const user = state.swipeDeck[state.swipeIndex];
  const topCard = $("#swipe-stack").querySelector(".swipe-card");
  if (!topCard) return;

  if (type === "skip") {
    topCard.style.transform = "translateX(-120%) rotate(-14deg)";
  } else if (type === "like") {
    const fd = new FormData();
    fd.append("tg_id", state.tgId);
    fd.append("target_id", user.id);
    try {
      const resp = await apiPost("/api/like", fd);
      if (resp.is_match) {
        alert("🎉 У вас Match з " + (user.display_name || "користувачем"));
        await loadPartners();
      }
    } catch (_) {}
    topCard.style.transform = "translateX(120%) rotate(14deg)";
  } else if (type === "super") {
    const fd = new FormData();
    fd.append("tg_id", state.tgId);
    fd.append("target_id", user.id);
    try {
      const resp = await apiPost("/api/superlike", fd);
      alert(
        "⭐ Суперлайк відправлено! Ти можеш писати користувачу навіть без взаємного лайка."
      );
      await loadPartners();
    } catch (_) {}
    topCard.style.transform = "translateY(-120%)";
  }

  setTimeout(() => {
    state.swipeIndex += 1;
    renderSwipeDeck();
  }, 220);
}

// ---------- LIST VIEW ---------- //

async function loadList() {
  const gender = $("#list-gender").value;
  const city = $("#list-city").value.trim();
  const data = await apiGet("/api/search", {
    tg_id: state.tgId,
    gender,
    city,
  });

  const container = $("#list-container");
  container.innerHTML = "";

  if (!data.users.length) {
    container.innerHTML = `<div class="empty-text">Нічого не знайдено</div>`;
    return;
  }

  data.users.forEach((u) => {
    const card = document.createElement("div");
    card.className = "list-card";

    card.innerHTML = `
      <img class="list-avatar" src="${
        u.photo ||
        "https://via.placeholder.com/200x200/020617/4b5563?text=No+Photo"
      }" alt="">
      <div class="list-main">
        <div class="list-name-row">
          <span class="list-name">${u.display_name || "Користувач"}</span>
          ${
            u.age
              ? `<span class="list-meta"> · ${u.age}</span>`
              : ""
          }
        </div>
        <div class="list-meta">${u.city || "Місто не вказано"}</div>
        <div class="list-meta">${
          u.bio ? u.bio.slice(0, 80) : "Без опису"
        }</div>
      </div>
      <div class="list-actions">
        <button class="btn-ghost small btn-open">👁</button>
        <button class="btn-ghost small btn-like-list">❤️</button>
        <button class="btn-ghost small btn-super-list">⭐</button>
      </div>
    `;

    card.querySelector(".btn-open").addEventListener("click", () => {
      openProfileModal(u);
    });
    card.querySelector(".btn-like-list").addEventListener("click", async () => {
      const fd = new FormData();
      fd.append("tg_id", state.tgId);
      fd.append("target_id", u.id);
      try {
        const resp = await apiPost("/api/like", fd);
        if (resp.is_match) {
          alert("🎉 Match!");
          await loadPartners();
        }
      } catch (_) {}
    });
    card
      .querySelector(".btn-super-list")
      .addEventListener("click", async () => {
        const fd = new FormData();
        fd.append("tg_id", state.tgId);
        fd.append("target_id", u.id);
        try {
          await apiPost("/api/superlike", fd);
          alert("⭐ Суперлайк відправлено!");
          await loadPartners();
        } catch (_) {}
      });

    container.appendChild(card);
  });
}

// ---------- PROFILE MODAL ---------- //

function openProfileModal(u) {
  const modal = $("#profile-modal");
  const body = $("#modal-body");

  body.innerHTML = `
    <div class="modal-profile">
      <img src="${
        u.photo ||
        "https://via.placeholder.com/400x300/020617/4b5563?text=No+Photo"
      }" alt="">
      <div class="modal-profile-body">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-weight:600;font-size:15px;">${
              u.display_name || "Користувач"
            } ${u.age ? ", " + u.age : ""}</div>
            <div style="font-size:12px;color:#9ca3af;">${
              u.city || "Місто не вказано"
            }</div>
          </div>
        </div>
        <div style="margin-top:6px;font-size:13px;">${
          u.bio || "Без опису"
        }</div>
        ${
          u.interests
            ? `<div style="margin-top:6px;font-size:12px;color:#9ca3af;">Інтереси: ${u.interests}</div>`
            : ""
        }
      </div>
    </div>
  `;

  modal.classList.remove("hidden");
}

function closeProfileModal() {
  $("#profile-modal").classList.add("hidden");
}

// ---------- MATCHES / PARTNERS LIST ---------- //

async function loadPartners() {
  const data = await apiGet("/api/matches", { tg_id: state.tgId });
  state.partners = data.matches || [];
  renderPartners();
}

function renderPartners() {
  const list = $("#partners-list");
  const empty = $("#partners-empty");
  list.innerHTML = "";

  if (!state.partners.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  state.partners.forEach((p) => {
    const card = document.createElement("div");
    card.className =
      "partner-card" +
      (state.activeChatPartner && state.activeChatPartner.id === p.id
        ? " active"
        : "");

    card.innerHTML = `
      <img class="partner-avatar" src="${
        p.photo ||
        "https://via.placeholder.com/100x100/020617/4b5563?text=No+Photo"
      }">
      <div class="partner-main">
        <div class="partner-name">${p.display_name || "Користувач"}</div>
        <div class="partner-meta">${
          p.city || ""
        }</div>
      </div>
    `;

    card.addEventListener("click", () => {
      state.activeChatPartner = p;
      renderPartners();
      loadChat();
    });

    list.appendChild(card);
  });
}

// ---------- CHAT ---------- //

async function loadChat() {
  const panelTitle = $("#chat-title");
  const panelSubtitle = $("#chat-subtitle");
  const messagesEl = $("#chat-messages");

  if (!state.activeChatPartner) {
    panelTitle.textContent = "Оберіть користувача";
    panelSubtitle.textContent = "";
    messagesEl.innerHTML =
      '<div class="empty-text">Тут з’являться ваші діалоги</div>';
    return;
  }

  panelTitle.textContent = state.activeChatPartner.display_name || "Користувач";
  panelSubtitle.textContent = state.activeChatPartner.city || "";

  try {
    const data = await apiGet("/api/messages", {
      tg_id: state.tgId,
      partner_id: state.activeChatPartner.id,
    });

    messagesEl.innerHTML = "";
    data.messages.forEach((m) => {
      const div = document.createElement("div");
      div.className = "chat-bubble " + (m.is_me ? "me" : "them");
      div.innerHTML = `
        <div>${m.body}</div>
        <div class="chat-time">${formatTime(m.time)}</div>
      `;
      messagesEl.appendChild(div);
    });

    messagesEl.scrollTop = messagesEl.scrollHeight;
  } catch (e) {
    messagesEl.innerHTML =
      '<div class="empty-text">Немає доступу до чату (ще немає матчу / суперлайка)</div>';
  }
}

async function sendChatMessage() {
  if (!state.activeChatPartner) return;
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;

  const fd = new FormData();
  fd.append("tg_id", state.tgId);
  fd.append("partner_id", state.activeChatPartner.id);
  fd.append("body", text);

  try {
    await apiPost("/api/messages/send", fd);
    input.value = "";
    await loadChat();
  } catch (e) {
    alert("Не вдалося надіслати повідомлення");
  }
}

function startChatPolling() {
  setInterval(() => {
    if (state.activeChatPartner) {
      loadChat();
    }
  }, 5000);
}

// ---------- EVENTS ---------- //

function bindEvents() {
  // tabs
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      setTab(tab.dataset.tab);
      if (tab.dataset.tab === "search") {
        loadList();
      } else if (tab.dataset.tab === "chat") {
        loadPartners();
      }
    });
  });

  // premium demo
  $("#btn-toggle-premium").addEventListener("click", () => {
    togglePremium().catch(() => {});
  });

  // invisible
  $("#toggle-invisible").addEventListener("change", () => {
    saveProfile(false).catch(() => {});
  });

  // swipe buttons
  $("#btn-skip").addEventListener("click", () => handleLike("skip"));
  $("#btn-like").addEventListener("click", () => handleLike("like"));
  $("#btn-superlike").addEventListener("click", () => handleLike("super"));

  $("#btn-swipe-refresh").addEventListener("click", () =>
    loadSwipeDeck().catch(() => {})
  );

  // list
  $("#btn-list-refresh").addEventListener("click", () =>
    loadList().catch(() => {})
  );

  // profile save
  $("#profile-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveProfile(false).catch(() => {});
  });

  $("#avatar-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        $("#avatar-preview").src = ev.target.result;
      };
      reader.readAsDataURL(file);
      saveProfile(true).catch(() => {});
    }
  });

  // chat
  $("#btn-chat-send").addEventListener("click", () => {
    sendChatMessage().catch(() => {});
  });
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendChatMessage().catch(() => {});
    }
  });

  // modal
  $("#modal-close").addEventListener("click", closeProfileModal);
  $("#profile-modal .modal-backdrop").addEventListener("click", closeProfileModal);
}

// ---------- INIT ---------- //

window.addEventListener("load", () => {
  bindEvents();
  initTelegram().catch((err) => {
    console.error(err);
    alert("Помилка ініціалізації WebApp");
  });
});
