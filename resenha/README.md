# Resenha: um "Discord" só seu, para até 10 pessoas, de graça

Um servidor só, com o visual do Discord atual: canais de texto, canais de voz, câmera, compartilhamento de tela, reações, respostas, menções, envio de arquivos, status, lista de membros e configurações de voz. Cada amigo instala o app no próprio PC (Windows, Mac ou Linux) e conecta pela internet. Ninguém precisa estar na mesma rede.

## Dá pra ser melhor que o Discord?

Para um grupo fechado de até 10 pessoas, **em vários pontos sim**:

| | Discord grátis | Resenha |
|---|---|---|
| Qualidade do áudio | 64 kbps | **128 kbps Opus** |
| Compartilhar tela | 720p/30fps (1080p/60 só com Nitro) | **1080p/60fps** |
| Limite de arquivo | 10 MB | **500 MB** (configurável) |
| Latência de voz | passa pelo servidor do Discord | **direto entre os PCs** (P2P), sem intermediário |
| Privacidade | dados no Discord | **tudo no seu servidor** |
| Anúncios / Nitro / limites | tem | não tem |
| Atualizar o app | cada um atualiza | **atualiza o servidor e todo mundo recebe na hora** |

Onde o Discord continua melhor (seria desonesto dizer o contrário):
- **Infraestrutura global.** Se o seu servidor cair, a Resenha cai. O Discord tem redundância no mundo inteiro.
- **Muita gente com vídeo ao mesmo tempo.** A voz é P2P em malha: cada pessoa envia o áudio dela para cada outra. Para voz isso é tranquilo (9 × 128 kbps ≈ 1,2 Mbps de upload). **Câmera/tela para 9 pessoas ao mesmo tempo** pode pesar no upload de quem transmite (tela 1080p ≈ 4 Mbps por pessoa assistindo). Veja [Limites](#limites).
- App de celular, bots, stickers, supressão de ruído com IA (Krisp) e integração com jogos. Aqui a supressão de ruído é a do Chromium, que é boa, mas não é o Krisp.

## Como funciona

<a id="arquitetura"></a>

```
 PC do amigo A ─┐                          ┌─ PC do amigo B
  (app Resenha) │   texto, presença,       │  (app Resenha)
                ├── sinalização ──► SERVIDOR ◄──┤
                │   (WebSocket)    (Node.js)    │
                │                               │
                └──────── voz / vídeo / tela ───┘
                     direto entre os PCs (WebRTC P2P)
```

- **`server/`**: Node.js + Socket.IO. Guarda contas, mensagens e arquivos numa pasta `data/` (JSON, sem banco para instalar). Também entrega a interface.
- **`web/`**: a interface (HTML/CSS/JS puro, sem build). Roda no app desktop e também em qualquer navegador.
- **`desktop/`**: o app que cada um instala (Electron). É uma "casca" que abre a interface do servidor, com barra de título própria, seletor de tela/janela, som do sistema na transmissão (Windows), bandeja do sistema e notificações.

## Passo a passo (tudo grátis)

### 1. Colocar o servidor no ar

O servidor precisa ficar ligado enquanto vocês usam. Escolha **uma** opção:

#### Opção A (recomendada): VM grátis para sempre na Oracle Cloud
A Oracle dá de graça, sem prazo, uma VM ARM com 4 núcleos e 24 GB de RAM ("Always Free"). Fica ligada 24h.

1. Crie a conta em <https://www.oracle.com/cloud/free/> (pede cartão para verificar identidade, mas não cobra nada no plano Always Free).
2. Crie uma instância Ubuntu (formato `VM.Standard.A1.Flex`).
3. Na VCN da instância, libere as portas **80, 443** (TCP) e **3478** (TCP e UDP) e **49160-49200** (UDP) nas "Ingress Rules". As duas últimas são para o TURN (passo 2).
4. Pegue um domínio grátis em <https://www.duckdns.org> (ex.: `minharesenha.duckdns.org`) apontando para o IP da VM.
5. Na VM:
   ```bash
   sudo apt update && sudo apt install -y git nodejs npm caddy
   git clone <este repositório> && cd <repo>/resenha/server
   npm install --omit=dev
   cp .env.example .env && nano .env      # defina INVITE_CODE e o resto
   # HTTPS automático com Let's Encrypt:
   echo 'minharesenha.duckdns.org {
     reverse_proxy localhost:3000
   }' | sudo tee /etc/caddy/Caddyfile && sudo systemctl restart caddy
   # Deixar rodando para sempre (reinicia sozinho):
   sudo npm install -g pm2 && pm2 start src/index.js --name resenha && pm2 save && pm2 startup
   ```
   Se preferir Docker: `docker build -t resenha . && docker run -d --restart=always -p 3000:3000 --env-file server/.env -v resenha-data:/app/server/data resenha` (rode a partir da pasta `resenha/`).
6. O endereço do servidor é `https://minharesenha.duckdns.org`.

> A Ubuntu da Oracle vem com iptables bloqueando portas. Se não conectar, rode `sudo iptables -I INPUT -p tcp -m multiport --dports 80,443,3478 -j ACCEPT && sudo iptables -I INPUT -p udp -m multiport --dports 3478,49160:49200 -j ACCEPT && sudo netfilter-persistent save`.

#### Opção B (mais fácil): servidor no seu PC + Tailscale
Bom se o seu PC fica ligado quando vocês jogam.

1. Instale o Node.js 18+ (<https://nodejs.org>).
2. Na pasta `resenha/server`: `npm install`, copie `.env.example` para `.env`, defina `INVITE_CODE` e rode `npm start`.
3. Todo mundo instala o **Tailscale** (<https://tailscale.com>, grátis até 100 dispositivos) e você convida os amigos para a sua rede Tailscale.
4. O endereço do servidor é `http://SEU-IP-TAILSCALE:3000` (ex.: `http://100.101.102.103:3000`).

Vantagem: dentro do Tailscale a voz praticamente sempre conecta direto, sem precisar de TURN. O app já trata esse endereço `http://` como seguro, então microfone e câmera funcionam. (No navegador comum, só funciona com HTTPS.)

#### Opção C (teste rápido): Cloudflare Tunnel
Com o servidor rodando no seu PC: `cloudflared tunnel --url http://localhost:3000`. Isso gera um endereço `https://algo.trycloudflare.com`. É grátis, mas o endereço muda sempre que você reinicia. Para um endereço fixo, precisa de um domínio próprio no Cloudflare.

### 2. TURN (recomendado para quem estiver no 4G ou em rede de faculdade/empresa)
A voz é P2P. Na maioria das redes domésticas ela conecta direto usando STUN, que já vem configurado. Em NAT mais restritivo (4G, CGNAT, empresa) é preciso um servidor **TURN** para retransmitir. Opções grátis:

- **Na mesma VM da Oracle** (melhor):
  ```bash
  sudo apt install -y coturn
  sudo tee /etc/turnserver.conf <<'EOF'
  listening-port=3478
  fingerprint
  lt-cred-mech
  user=resenha:UMA-SENHA-FORTE
  realm=minharesenha.duckdns.org
  min-port=49160
  max-port=49200
  no-cli
  EOF
  sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
  sudo systemctl restart coturn
  ```
  E no `.env` do servidor:
  ```
  TURN_URLS=turn:minharesenha.duckdns.org:3478?transport=udp,turn:minharesenha.duckdns.org:3478?transport=tcp
  TURN_USERNAME=resenha
  TURN_CREDENTIAL=UMA-SENHA-FORTE
  ```
- **Metered Open Relay** (<https://www.metered.ca/tools/openrelay/>): tem plano grátis com cota mensal. Coloque as credenciais nas mesmas variáveis.

### 3. Gerar os instaladores (GitHub Actions, grátis)
1. *(Opcional, mas recomendado)* Em `desktop/package.json`, preencha `"resenha": { "defaultServer": "https://minharesenha.duckdns.org" }`. Assim o app já abre conectado e os amigos não precisam digitar nada.
2. No GitHub: aba **Actions** > **Resenha - instaladores** > **Run workflow**.
3. Em uns 10 minutos aparecem os arquivos para baixar no fim da página da execução:
   - `Resenha-Setup-1.0.0.exe` (Windows)
   - `Resenha-1.0.0-arm64.dmg` (Mac)
   - `Resenha-1.0.0.AppImage` (Linux)

   Se criar uma tag `resenha-v1.0.0` e der push, os instaladores vão para um Release público do GitHub.

Para gerar localmente: `cd desktop && npm install && npm run dist`. O `.exe` precisa ser gerado no Windows (ou pelo Actions).

> **Aviso do Windows/Mac:** o app não é assinado digitalmente (o certificado é pago). No Windows, o SmartScreen mostra um aviso: clique em **Mais informações > Executar assim mesmo**. No Mac, clique com o botão direito no app > **Abrir**. Isso só acontece na primeira vez.

### 4. Convidar os amigos
Mande para cada um: o instalador, o endereço do servidor (se não fixou no passo 3) e o **código de convite** (`INVITE_CODE`). A **primeira conta criada vira administradora**: pode criar, renomear e apagar canais, mudar nome e ícone do servidor e expulsar membros. O servidor recusa a 11ª conta (`MAX_USERS`).

## Recursos

- Canais de texto: markdown (`**negrito**`, `*itálico*`, `__sublinhado__`, `~~riscado~~`, `||spoiler||`, código, citação), @menções com autocompletar, `@everyone`, respostas, reações com emoji, editar (inclusive com a seta ↑), apagar, "fulano está digitando…", separador de dia, agrupamento de mensagens, contagem de não lidas e de menções, histórico infinito.
- Arquivos: arrastar e soltar, colar imagem com Ctrl+V, barra de progresso, prévia de imagem/vídeo/áudio, visualizador de imagem.
- Voz: vários canais, quem está falando fica com contorno verde, silenciar/ensurdecer (Ctrl+Shift+M / Ctrl+Shift+D), volume por pessoa (botão direito no nome), pressionar para falar, escolha de microfone e saída, volume de entrada, teste de microfone, supressão de ruído, cancelamento de eco, controle de ganho, sons de entrar/sair e reconexão automática.
- Vídeo: câmera 720p e transmissão de tela até 1080p/60fps com som do sistema (Windows), seletor de tela/janela, foco em um participante e tela cheia.
- Perfil: avatar (upload), cor, status (Disponível / Ausente / Não perturbe / Invisível), status personalizado e troca de senha.
- App desktop: barra de título integrada, minimiza para a bandeja (a chamada continua), notificações nativas, contador de menções no ícone e links abrindo no navegador.

## Limites

Upload necessário **de quem transmite** numa chamada com N pessoas (malha P2P):

| O que você transmite | 4 pessoas | 10 pessoas |
|---|---|---|
| Só voz (128 kbps) | ~0,4 Mbps | ~1,2 Mbps |
| Câmera 720p (1,5 Mbps) | ~4,5 Mbps | ~13,5 Mbps |
| Tela 1080p (até 4 Mbps) | ~12 Mbps | ~36 Mbps |

Voz com 10 pessoas funciona em qualquer internet. Com vídeo, o WebRTC reduz a qualidade sozinho quando falta banda. Se o seu grupo vive com muita gente em vídeo ao mesmo tempo, o próximo passo seria trocar a malha por um SFU (ex.: LiveKit, também gratuito e self-hosted). A arquitetura já está separada para permitir essa troca.

## Desenvolvimento

```bash
cd server && npm install && INVITE_CODE=teste npm start   # http://localhost:3000
cd desktop && npm install && npm start                   # app desktop
```

Configurações do servidor (`server/.env`): `PORT`, `INVITE_CODE`, `SERVER_NAME`, `MAX_USERS`, `MAX_UPLOAD_MB`, `DATA_DIR`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.

Backup: copie a pasta `server/data/`.
