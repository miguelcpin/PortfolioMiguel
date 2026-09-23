import { icons } from './icons.js';
import { $, $$, h, escapeHtml, avatarHtml, toast, confirmDialog } from './util.js';

const COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f0b232', '#23a55a', '#00a8fc', '#9b59b6', '#e67e22', '#1abc9c', '#95a5a6'];

function upload(file, token) {
  return fetch('api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Falha no envio.');
    return data;
  });
}

export function openSettings(ctx, section = 'account') {
  $('.settings')?.remove();
  const { S } = ctx;
  const el = h(`<div class="settings">
    <nav class="settings-nav"><div>
      <div class="sn-title">Configurações de usuário</div>
      <button class="sn-item" data-s="account">Minha conta</button>
      <button class="sn-item" data-s="voice">Voz e vídeo</button>
      <button class="sn-item" data-s="app">Notificações e app</button>
      ${S.me.isAdmin ? `<div class="sn-sep"></div><div class="sn-title">${escapeHtml(S.serverName)}</div>
      <button class="sn-item" data-s="server">Visão geral do servidor</button>
      <button class="sn-item" data-s="members">Membros</button>` : ''}
      <div class="sn-sep"></div>
      <button class="sn-item danger" data-s="logout">Sair</button>
    </div></nav>
    <div class="settings-content scroller"><div id="settings-body"></div></div>
    <div class="settings-close"><button title="Fechar (Esc)">${icons.close}</button><small>ESC</small></div>
  </div>`);
  document.body.append(el);

  let cleanup = null;
  const close = () => {
    cleanup?.();
    el.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !$('.modal-layer')) close();
  };
  document.addEventListener('keydown', onKey, true);
  $('.settings-close button', el).addEventListener('click', close);

  const show = (name) => {
    if (name === 'logout') {
      confirmDialog({ title: 'Sair', text: 'Tem certeza que deseja sair?', confirm: 'Sair' }).then((ok) => ok && ctx.logout());
      return;
    }
    cleanup?.();
    cleanup = null;
    $$('.sn-item', el).forEach((b) => b.classList.toggle('active', b.dataset.s === name));
    const body = $('#settings-body', el);
    body.innerHTML = '';
    cleanup = SECTIONS[name](body, ctx) || null;
  };
  $$('.sn-item', el).forEach((b) => b.addEventListener('click', () => show(b.dataset.s)));
  show(section);
}

const SECTIONS = {
  account(body, ctx) {
    const { S, socket } = ctx;
    const draw = () => {
      const me = S.users.get(S.me.id) || S.me;
      body.innerHTML = `<h2>Minha conta</h2>
        <div class="account-card">
          <div class="ac-banner" style="background:${escapeHtml(me.color)}"></div>
          <div class="ac-row">${avatarHtml(me, 80)}<div class="ac-name">${escapeHtml(me.username)}</div></div>
          <div class="ac-box">
            <h3 style="margin-top:0">Avatar</h3>
            <div class="row">
              <button class="btn primary" id="av-up">Enviar imagem</button>
              ${me.avatar ? '<button class="btn link" id="av-rm">Remover avatar</button>' : ''}
              <input type="file" id="av-file" accept="image/*" hidden>
            </div>
            <h3>Cor do perfil</h3>
            <div class="color-row">${COLORS.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === me.color ? 'sel' : ''}"></button>`).join('')}</div>
          </div>
        </div>
        <h3>Trocar senha</h3>
        <div class="grid-2">
          <input class="input" type="password" id="pw-cur" placeholder="Senha atual" autocomplete="current-password">
          <input class="input" type="password" id="pw-new" placeholder="Nova senha" autocomplete="new-password">
        </div>
        <button class="btn primary" id="pw-save" style="margin-top:12px">Trocar senha</button>`;
      $('#av-up', body).addEventListener('click', () => $('#av-file', body).click());
      $('#av-file', body).addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        if (f.size > 8 * 1024 * 1024) return toast('Use uma imagem de até 8 MB.', 'error');
        try {
          const res = await upload(f, S.token);
          socket.emit('user:update', { avatar: res.url }, () => setTimeout(draw, 50));
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      $('#av-rm', body)?.addEventListener('click', () => socket.emit('user:update', { avatar: null }, () => setTimeout(draw, 50)));
      $$('.color-row button', body).forEach((b) => b.addEventListener('click', () => socket.emit('user:update', { color: b.dataset.c }, () => setTimeout(draw, 50))));
      $('#pw-save', body).addEventListener('click', async () => {
        const res = await ctx.emitAck('user:password', { current: $('#pw-cur', body).value, next: $('#pw-new', body).value });
        if (res.error) toast(res.error, 'error');
        else {
          toast('Senha alterada.', 'success');
          $('#pw-cur', body).value = $('#pw-new', body).value = '';
        }
      });
    };
    draw();
  },

  voice(body, ctx) {
    const { voice } = ctx;
    const s = voice.settings;
    body.innerHTML = `<h2>Voz e vídeo</h2>
      <div class="grid-2">
        <div><h3>Dispositivo de entrada</h3><select class="input" id="in-dev"></select></div>
        <div><h3>Dispositivo de saída</h3><select class="input" id="out-dev"></select></div>
      </div>
      <h3>Volume de entrada</h3>
      <input type="range" id="in-gain" min="0" max="300" value="${Math.round(s.inputGain * 100)}">
      <h3>Teste de microfone</h3>
      <div class="row"><button class="btn primary" id="mic-test">Vamos checar</button><span class="muted" style="font-size:14px">Fale algo e veja a barra se mexer.</span></div>
      <div class="meter"><i id="mic-meter"></i></div>

      <h3>Modo de entrada</h3>
      <div class="switch-row"><div class="sr-text"><b>Pressionar para falar</b><small>Só transmite enquanto a tecla estiver pressionada (com o app em foco).</small></div><label class="switch"><input type="checkbox" id="ptt" ${s.pushToTalk ? 'checked' : ''}><span></span></label></div>
      <div class="switch-row" id="ptt-row" ${s.pushToTalk ? '' : 'hidden'}><div class="sr-text"><b>Tecla</b><small>Clique no botão e aperte a tecla desejada.</small></div><button class="btn secondary" id="ptt-key"><span class="kbd">${escapeHtml(s.pushToTalkKey.replace(/^Key|^Digit/, ''))}</span></button></div>

      <h3>Processamento de voz</h3>
      <div class="switch-row"><div class="sr-text"><b>Supressão de ruído</b><small>Remove barulho de fundo (ventilador, teclado).</small></div><label class="switch"><input type="checkbox" id="ns" ${s.noiseSuppression ? 'checked' : ''}><span></span></label></div>
      <div class="switch-row"><div class="sr-text"><b>Cancelamento de eco</b><small>Evita que os outros ouçam a própria voz se você usa caixa de som.</small></div><label class="switch"><input type="checkbox" id="ec" ${s.echoCancellation ? 'checked' : ''}><span></span></label></div>
      <div class="switch-row"><div class="sr-text"><b>Controle automático de ganho</b><small>Ajusta o volume do microfone automaticamente.</small></div><label class="switch"><input type="checkbox" id="agc" ${s.autoGainControl ? 'checked' : ''}><span></span></label></div>
      <p class="muted" style="font-size:14px;margin-top:16px">Qualidade de áudio: Opus 128 kbps (o Discord grátis usa 64 kbps). Tela: até 1080p/60fps sem precisar de Nitro.</p>`;

    const fill = async () => {
      let devices = [];
      try {
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {}
      const opt = (d, sel) => `<option value="${escapeHtml(d.deviceId)}" ${d.deviceId === sel ? 'selected' : ''}>${escapeHtml(d.label || (d.deviceId === 'default' ? 'Padrão' : 'Dispositivo'))}</option>`;
      const ins = devices.filter((d) => d.kind === 'audioinput');
      const outs = devices.filter((d) => d.kind === 'audiooutput');
      $('#in-dev', body).innerHTML = (ins.some((d) => d.deviceId === 'default') ? '' : '<option value="default">Padrão</option>') + ins.map((d) => opt(d, s.inputDeviceId)).join('');
      $('#out-dev', body).innerHTML = (outs.some((d) => d.deviceId === 'default') ? '' : '<option value="default">Padrão</option>') + outs.map((d) => opt(d, s.outputDeviceId)).join('');
    };
    fill();

    const persist = () => ctx.saveVoiceSettings();
    const restart = () => voice.restartMic().catch((e) => toast('Falha ao trocar microfone: ' + e.message, 'error'));

    $('#in-dev', body).addEventListener('change', (e) => {
      s.inputDeviceId = e.target.value;
      persist();
      restart();
      if (test) startTest();
    });
    $('#out-dev', body).addEventListener('change', (e) => {
      voice.setOutputDevice(e.target.value);
      persist();
    });
    $('#in-gain', body).addEventListener('input', (e) => {
      voice.setInputGain(e.target.value / 100);
      if (testGain) testGain.gain.value = e.target.value / 100;
      persist();
    });
    for (const [id, key] of [['ns', 'noiseSuppression'], ['ec', 'echoCancellation'], ['agc', 'autoGainControl']]) {
      $('#' + id, body).addEventListener('change', (e) => {
        s[key] = e.target.checked;
        persist();
        restart();
      });
    }
    $('#ptt', body).addEventListener('change', (e) => {
      s.pushToTalk = e.target.checked;
      $('#ptt-row', body).hidden = !s.pushToTalk;
      voice.applyMicEnabled();
      persist();
    });
    $('#ptt-key', body).addEventListener('click', (e) => {
      const btn = e.currentTarget;
      btn.innerHTML = '<span class="kbd">Aperte uma tecla…</span>';
      const onKey = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        s.pushToTalkKey = ev.code;
        btn.innerHTML = `<span class="kbd">${escapeHtml(ev.code.replace(/^Key|^Digit/, ''))}</span>`;
        persist();
        window.removeEventListener('keydown', onKey, true);
      };
      window.addEventListener('keydown', onKey, true);
    });

    // Teste de microfone independente da chamada
    let test = null;
    let testGain = null;
    let raf = 0;
    let audioCtx = null;
    const stopTest = () => {
      cancelAnimationFrame(raf);
      test?.getTracks().forEach((t) => t.stop());
      test = null;
      audioCtx?.close();
      audioCtx = null;
      const m = $('#mic-meter', body);
      if (m) m.style.width = '0';
      const b = $('#mic-test', body);
      if (b) b.textContent = 'Vamos checar';
    };
    const startTest = async () => {
      stopTest();
      try {
        test = await navigator.mediaDevices.getUserMedia({ audio: voice.micConstraints() });
      } catch (e) {
        return toast('Não foi possível abrir o microfone.', 'error');
      }
      fill(); // agora temos permissão, os nomes dos dispositivos aparecem
      audioCtx = new AudioContext();
      const src = audioCtx.createMediaStreamSource(test);
      testGain = audioCtx.createGain();
      testGain.gain.value = s.inputGain;
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(testGain).connect(an);
      // Toca de volta para você se ouvir
      testGain.connect(audioCtx.destination);
      const data = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += (v - 128) ** 2;
        const lvl = Math.min(1, (Math.sqrt(sum / data.length) / 128) * 4);
        $('#mic-meter', body).style.width = Math.round(lvl * 100) + '%';
        raf = requestAnimationFrame(loop);
      };
      loop();
      $('#mic-test', body).textContent = 'Parar teste';
    };
    $('#mic-test', body).addEventListener('click', () => (test ? stopTest() : startTest()));
    return stopTest;
  },

  app(body, ctx) {
    const { S, desktop } = ctx;
    body.innerHTML = `<h2>Notificações e app</h2>
      <div class="switch-row"><div class="sr-text"><b>Notificações na área de trabalho</b><small>Avisa sobre mensagens novas quando o app não está em foco.</small></div><label class="switch"><input type="checkbox" id="pn" ${S.prefs.notifications ? 'checked' : ''}><span></span></label></div>
      <div class="switch-row"><div class="sr-text"><b>Sons</b><small>Mensagens, entrar/sair da voz, silenciar.</small></div><label class="switch"><input type="checkbox" id="ps" ${S.prefs.sounds ? 'checked' : ''}><span></span></label></div>
      <h3>Atalhos</h3>
      <p class="muted" style="font-size:14px"><span class="kbd">Ctrl</span> + <span class="kbd">Shift</span> + <span class="kbd">M</span> silenciar ·
      <span class="kbd">Ctrl</span> + <span class="kbd">Shift</span> + <span class="kbd">D</span> ensurdecer ·
      <span class="kbd">↑</span> editar última mensagem · <span class="kbd">Shift</span> + <span class="kbd">Enter</span> nova linha</p>
      <h3>Formatação</h3>
      <p class="muted" style="font-size:14px">**negrito** · *itálico* · __sublinhado__ · ~~riscado~~ · ||spoiler|| · \`código\` · \`\`\`bloco\`\`\` · &gt; citação · @nome</p>
      ${desktop ? `<h3>Servidor</h3><p class="muted" style="font-size:14px">Conectado a <b>${escapeHtml(location.origin)}</b></p><button class="btn secondary" id="chg-srv">Trocar servidor</button>` : ''}`;
    $('#pn', body).addEventListener('change', (e) => {
      S.prefs.notifications = e.target.checked;
      if (e.target.checked && 'Notification' in window) Notification.requestPermission();
      ctx.savePrefs();
    });
    $('#ps', body).addEventListener('change', (e) => {
      S.prefs.sounds = e.target.checked;
      ctx.savePrefs();
    });
    $('#chg-srv', body)?.addEventListener('click', () => desktop.changeServer());
  },

  server(body, ctx) {
    const { S, socket } = ctx;
    const draw = () => {
      body.innerHTML = `<h2>Visão geral do servidor</h2>
        <div class="row" style="align-items:flex-start;gap:24px">
          <div class="guild-icon" style="width:100px;height:100px;border-radius:50%;font-size:32px;background:var(--brand);color:#fff;cursor:default">${S.serverIcon ? `<img src="${escapeHtml(S.serverIcon)}" alt="">` : escapeHtml(S.serverName.slice(0, 2))}</div>
          <div style="flex:1">
            <h3 style="margin-top:0">Nome do servidor</h3>
            <input class="input" id="srv-name" value="${escapeHtml(S.serverName)}" maxlength="50">
            <div class="row" style="margin-top:12px">
              <button class="btn primary" id="srv-save">Salvar</button>
              <button class="btn secondary" id="srv-icon">Trocar ícone</button>
              ${S.serverIcon ? '<button class="btn link" id="srv-icon-rm">Remover ícone</button>' : ''}
              <input type="file" id="srv-file" accept="image/*" hidden>
            </div>
          </div>
        </div>
        <h3>Convidar amigos</h3>
        <p class="muted" style="font-size:14px">Mande para cada amigo: (1) o instalador do app, (2) o endereço <b>${escapeHtml(location.origin)}</b> e (3) o código de convite que você definiu em <code>INVITE_CODE</code> no servidor. Vagas usadas: ${S.users.size}.</p>`;
      $('#srv-save', body).addEventListener('click', async () => {
        const res = await ctx.emitAck('server:update', { name: $('#srv-name', body).value });
        res.error ? toast(res.error, 'error') : toast('Salvo!', 'success');
      });
      $('#srv-icon', body).addEventListener('click', () => $('#srv-file', body).click());
      $('#srv-file', body).addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const up = await upload(f, S.token);
          socket.emit('server:update', { icon: up.url }, () => setTimeout(draw, 50));
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      $('#srv-icon-rm', body)?.addEventListener('click', () => socket.emit('server:update', { icon: null }, () => setTimeout(draw, 50)));
    };
    draw();
  },

  members(body, ctx) {
    const { S } = ctx;
    const draw = () => {
      const list = [...S.users.values()].sort((a, b) => a.username.localeCompare(b.username));
      body.innerHTML = `<h2>Membros (${list.length})</h2><div id="am-list"></div>`;
      for (const u of list) {
        const row = h(`<div class="admin-member">${avatarHtml(u, 32)}<div class="am-name">${escapeHtml(u.username)} ${u.isAdmin ? '<span class="admin-tag">ADM</span>' : ''}</div>${u.id !== S.me.id ? '<button class="btn danger">Expulsar</button>' : ''}</div>`);
        $('button', row)?.addEventListener('click', async () => {
          await ctx.kickUser(u);
          setTimeout(draw, 200);
        });
        $('#am-list', body).append(row);
      }
    };
    draw();
  },
};
