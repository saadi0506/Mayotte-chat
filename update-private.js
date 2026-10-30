const fs = require("fs");

const file = "public/index.html";
let html = fs.readFileSync(file, "utf8");

function replaceOnce(oldText, newText, label) {
    if (!html.includes(oldText)) {
        throw new Error("Élément introuvable : " + label);
    }
    html = html.replace(oldText, newText);
    console.log("OK : " + label);
}

replaceOnce(
'<button class="nav" data-page="chat">💬 Salon général</button>',
'<button class="nav" data-page="chat">💬 Salon général</button>\n   <button class="nav" data-page="private">✉️ Messages privés</button>',
"Navigation privée"
);

replaceOnce(
'   <section class="panel" id="profile">',
`   <section class="panel" id="private">
    <h1>✉️ Mes conversations</h1>
    <div class="card">
      <div id="conversationList">Chargement...</div>
    </div>
    <div class="card" id="privateBox" style="display:none">
      <h3 id="privateTitle"></h3>
      <div id="privateMessages" style="height:350px;overflow:auto"></div>
      <form id="privateForm" class="row">
        <input id="privateInput" placeholder="Votre message..." maxlength="2000" required>
        <button>Envoyer</button>
      </form>
    </div>
   </section>

   <section class="panel" id="profile">`,
"Interface des conversations"
);

replaceOnce(
'function navigate(page) {',
`
let activeFriend = null;

async function loadConversations() {
 const box = $("conversationList");
 box.replaceChildren();

 try {
  const conversations = await api("/api/conversations");

  if (!conversations.length) {
   box.textContent = "Ajoutez des amis pour commencer à discuter.";
   return;
  }

  conversations.forEach(c => {
   const row = document.createElement("div");
   row.className = "person";

   const info = document.createElement("div");
   info.className = "person-info";

   const name = document.createElement("strong");
   name.textContent = c.friend.username;

   const preview = document.createElement("small");
   preview.textContent = c.lastMessage || "Nouvelle conversation";

   const button = document.createElement("button");
   button.textContent = c.unread ? "Ouvrir (" + c.unread + ")" : "Ouvrir";
   button.onclick = () => openPrivate(c.friend);

   info.append(name, preview);
   row.append(info, button);
   box.append(row);
  });

 } catch(e) {
  box.textContent = e.message;
 }
}

async function openPrivate(friend) {
 activeFriend = friend;

 $("privateBox").style.display = "block";
 $("privateTitle").textContent = "Discussion avec " + friend.username;
 $("privateMessages").replaceChildren();

 connectChat();

 try {
  const messages = await api("/api/messages/" + encodeURIComponent(friend.id));

  messages.forEach(addPrivateMessage);

  await api("/api/messages/" + encodeURIComponent(friend.id) + "/read", {
   method: "POST"
  });

  await loadConversations();

 } catch(e) {
  alert(e.message);
 }
}

function addPrivateMessage(data) {
 const box = document.createElement("div");
 box.className = "message";

 const title = document.createElement("strong");
 title.textContent = data.sender_id === activeFriend.id
  ? activeFriend.username
  : "Vous";

 const content = document.createElement("p");
 content.textContent = data.content;

 const date = document.createElement("small");
 date.textContent = data.created_at || "";

 box.append(title, content, date);
 $("privateMessages").append(box);
 $("privateMessages").scrollTop = $("privateMessages").scrollHeight;
}

$("privateForm").onsubmit = async e => {
 e.preventDefault();

 if (!activeFriend) return;

 const content = $("privateInput").value.trim();
 if (!content) return;

 try {
  const message = await api(
   "/api/messages/" + encodeURIComponent(activeFriend.id),
   {
    method: "POST",
    body: JSON.stringify({content})
   }
  );

  addPrivateMessage(message);
  $("privateInput").value = "";
  await loadConversations();

 } catch(err) {
  alert(err.message);
 }
};

function navigate(page) {`,
"Fonctions de messagerie"
);

replaceOnce(
' if(page==="friends") loadFriends();',
' if(page==="friends") loadFriends();\n if(page==="private") loadConversations();',
"Navigation des conversations"
);

replaceOnce(
' socket=io();',
` socket=io();

 socket.on("private message", data => {
  if(activeFriend &&
    (data.sender_id === activeFriend.id ||
     data.receiver_id === activeFriend.id)) {

   addPrivateMessage(data);

   if(data.sender_id === activeFriend.id) {
    api("/api/messages/" + encodeURIComponent(activeFriend.id) + "/read", {
     method: "POST"
    }).catch(console.error);
   }
  }

  loadConversations();
 });`,
"Réception des messages privés"
);

fs.writeFileSync(file, html, "utf8");

console.log("\\nMAYOTTE CHAT : interface privée installée !");
