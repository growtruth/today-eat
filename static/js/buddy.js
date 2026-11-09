/* 谁陪我吃呀：饭搭子目录、邀请、位置加权抽取、骰子结账 */
(function () {
  'use strict';

  const CUISINE_PICKS = ['火锅', '日料', '烧烤', '川菜', '西餐', '小吃', '咖啡', '奶茶', '甜品'];

  /* 用当前访问域名 + sharecode 拼邀请链接：后端拿到的是内网 host，直接用会外网打不开 */
  function buildInviteUrl(token) {
    const base = location.origin;
    const sharecode = new URLSearchParams(location.search).get('sharecode');
    let url = base + '/i/' + token;
    if (sharecode) url += '?sharecode=' + encodeURIComponent(sharecode);
    return url;
  }

  /* 当前城市：优先用定位时存下的 city，退化为从「深圳市福田区…」里截取 */
  function currentCity() {
    const location = App.state.location || {};
    if (location.city) return location.city;
    const match = (location.label || '').match(/^(.{2,8}?市)/);
    return match ? match[1] : '';
  }

  function today() {
    const now = new Date();
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  /* 两点直线距离（km），用来判断地理编码结果是不是在用户所在城市附近 */
  function distanceKm(aLat, aLng, bLat, bLng) {
    const rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad;
    const dLng = (bLng - aLng) * rad;
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  const Buddy = {
    items: [],
    ready: false,
    error: null,
    tab: 'list',
    selectedId: null,
    rolling: false,
    lastDraw: null,
    backfilling: false,
    failedBackfill: new Set(),

    init() {
      const self = this;

      const close = document.getElementById('buddyClose');
      if (close) close.addEventListener('click', () => self.close());

      document.querySelectorAll('[data-btab]').forEach((btn) => {
        btn.addEventListener('click', () => self.switchTab(btn.dataset.btab));
      });

      const add = document.getElementById('buddyAddBtn');
      if (add) add.addEventListener('click', () => self.openAdd());

      const invite = document.getElementById('buddyInviteBtn');
      if (invite) invite.addEventListener('click', () => self.openInvite());

      const draw = document.getElementById('buddyDrawBtn');
      if (draw) draw.addEventListener('click', () => self.draw());

      const wechat = document.getElementById('buddyWechatBtn');
      if (wechat) wechat.addEventListener('click', () => self.wechatLogin());

      const roll = document.getElementById('diceRollBtn');
      if (roll) roll.addEventListener('click', () => self.rollDice());
    },

    /* ---------------- 会话 ---------------- */
    async ensureSession(force) {
      if (this.ready && !force) return true;
      if (this.pending) return this.pending;

      this.pending = (async () => {
        try {
          const data = await API.authDevice(Store.deviceId());
          App.state.user = data.user || null;
          this.ready = true;
          this.error = null;
          return true;
        } catch (error) {
          this.ready = false;
          this.error = error;
          return false;
        } finally {
          this.pending = null;
        }
      })();
      return this.pending;
    },

    /* 包装一次接口调用：会话过期（30 天）时自动重建身份并重试一次 */
    async call(fn) {
      try {
        return await fn();
      } catch (error) {
        if (error && error.code === 'auth_required') {
          this.ready = false;
          if (await this.ensureSession(true)) return await fn();
        }
        throw error;
      }
    },

    async refresh() {
      if (!(await this.ensureSession())) {
        this.renderProfile();
        this.renderList();
        return;
      }
      try {
        const data = await this.call(() => API.buddies());
        this.items = data.items || [];
        this.error = null;
      } catch (error) {
        this.error = error;
        this.items = [];
      }
      if (!this.selectedId && this.items.length) this.selectedId = this.items[0].id;
      if (this.selectedId && !this.items.some((item) => item.id === this.selectedId)) {
        this.selectedId = this.items.length ? this.items[0].id : null;
      }
      this.renderProfile();
      this.renderList();
      this.renderDicePick();
      this.loadHistory();
      this.backfillCoords();
    },

    /* 老搭子只有商圈、没有坐标：静默补一次（每轮最多 3 个，失败的不再重试） */
    async backfillCoords() {
      if (this.backfilling) return;
      const targets = this.items
        .filter((item) => item.area && (item.lat === null || item.lng === null) && !this.failedBackfill.has(item.id))
        .slice(0, 3);
      if (!targets.length) return;
      this.backfilling = true;
      try {
        for (const buddy of targets) {
          const place = await this.geocodeArea(buddy.area);
          if (!place) {
            this.failedBackfill.add(buddy.id);
            continue;
          }
          try {
            const updated = await this.call(() =>
              API.updateBuddy(buddy.id, { lat: place.lat, lng: place.lng }));
            const target = this.items.filter((item) => item.id === buddy.id)[0];
            if (target && updated.buddy) Object.assign(target, updated.buddy);
          } catch (error) {
            this.failedBackfill.add(buddy.id);
          }
        }
        this.renderList();
      } finally {
        this.backfilling = false;
      }
    },

    /* ---------------- 浮层 ---------------- */
    async open() {
      const layer = document.getElementById('buddyLayer');
      if (!layer) return;
      layer.classList.add('is-open');
      layer.setAttribute('aria-hidden', 'false');
      App.state.buddyOpen = true;
      document.body.classList.add('is-checkin');
      App.updateChrome();
      this.renderList();
      App.util.loading(true, '正在读取饭搭子…');
      await this.refresh();
      App.util.loading(false);
    },

    close() {
      const layer = document.getElementById('buddyLayer');
      if (!layer) return;
      layer.classList.remove('is-open');
      layer.setAttribute('aria-hidden', 'true');
      App.state.buddyOpen = false;
      document.body.classList.remove('is-checkin');
      App.updateChrome();
    },

    switchTab(tab) {
      this.tab = tab === 'dice' ? 'dice' : 'list';
      document.querySelectorAll('[data-btab]').forEach((btn) => {
        const on = btn.dataset.btab === this.tab;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const list = document.getElementById('buddyListView');
      const dice = document.getElementById('diceView');
      if (list) list.hidden = this.tab !== 'list';
      if (dice) dice.hidden = this.tab !== 'dice';
      if (this.tab === 'dice') {
        this.renderDicePick();
        this.loadHistory();
      }
    },

    /* ---------------- 渲染 ---------------- */
    renderProfile() {
      const user = App.state.user;
      // 后端 public_user() 返回 wechat / cloud 两个布尔字段
      const wechatBound = !!(user && (user.wechat || user.wechatOpenid));
      const cloudBound = !!(user && user.cloud);
      const configured = !!(App.boot && App.boot.wechatConfigured);
      const accountEnabled = !!(window.Cloud && Cloud.enabled);
      const el = document.getElementById('buddyMe');
      if (el) {
        if (user) {
          const tag = cloudBound ? ' · 账号已登录' : (wechatBound ? ' · 微信已登录' : ' · 本机身份');
          el.textContent = (user.nickname || '我') + tag;
        } else {
          el.textContent = this.error ? '身份服务未连上，搭子功能暂不可用' : '正在建立本机身份…';
        }
      }
      const btn = document.getElementById('buddyWechatBtn');
      if (!btn) return;
      btn.hidden = false;
      btn.disabled = wechatBound || cloudBound;
      // 三种入口：微信授权 → 账号登录 → 说明（都没有时）
      btn.dataset.mode = configured ? 'wechat' : (accountEnabled ? 'cloud' : 'help');
      if (btn.disabled) btn.textContent = '已登录';
      else btn.textContent = configured ? '微信登录' : (accountEnabled ? '账号登录' : '微信登录');
    },

    wechatLogin() {
      if (App.state.user && (App.state.user.cloud || App.state.user.wechat || App.state.user.wechatOpenid)) {
        App.util.toast('已经登录了');
        return;
      }
      if (App.boot && App.boot.wechatConfigured) {
        // 分享码要带进授权链路：漏了会被访问门禁挡成 403
        const sharecode = new URLSearchParams(location.search).get('sharecode');
        let url = '/auth/wechat?next=' + encodeURIComponent('/');
        if (sharecode) url += '&sharecode=' + encodeURIComponent(sharecode);
        location.href = url;
        return;
      }
      if (window.Cloud && Cloud.enabled) {
        this.accountLogin();
        return;
      }
      this.openWechatHelp();
    },

    /** WorkBuddy 账号登录：授权回来后由 app.js 换本站会话 */
    async accountLogin() {
      if (!(window.Cloud && Cloud.enabled)) {
        this.openWechatHelp();
        return;
      }
      App.util.loading(true, '正在打开账号登录…');
      try {
        const result = await Cloud.signInWithWorkBuddy();
        if (result && result.error) {
          App.util.loading(false);
          App.util.toast((result.error && result.error.message) || '登录没打开，稍后再试');
        }
        // 成功会整页跳转到授权页，这里不用收尾
      } catch (error) {
        App.util.loading(false);
        App.util.toast('登录没打开，稍后再试');
      }
    },

    /* 没有可用登录方式时的说明：缺什么、现在能用什么 */
    openWechatHelp() {
      const accountEnabled = !!(window.Cloud && Cloud.enabled);
      const body =
        '<p style="font-size:12.5px;line-height:1.8;color:#4A3F3A">' +
        (accountEnabled
          ? '账号登录暂时没打开。可以稍后重试，或先用本机身份。'
          : '微信网页授权需要认证服务号的 <b>AppID / Secret</b>，并把当前域名加进公众号后台的「网页授权域名」。' +
            '当前这个分享域名无法在公众号后台登记，所以线上只能用本机身份。') +
        '</p>' +
        '<p style="margin-top:10px;font-size:11px;line-height:1.7;color:#9B8E86">' +
        '本机身份：数据存在当前浏览器里，换设备或清缓存会重新开始；搭子、邀请、骰子都能正常用。' +
        '</p>';
      App.util.openSheet({
        title: '登录方式未启用',
        subtitle: '当前使用本机身份',
        body: body,
        actions: [{ label: '知道了', variant: 'ghost' }]
      });
    },

    renderList() {
      const box = document.getElementById('buddyList');
      const count = document.getElementById('buddyCount');
      if (count) count.textContent = String(this.items.length);
      if (!box) return;

      if (this.error) {
        box.innerHTML =
          '<div class="buddy-empty"><div class="emoji">🔌</div>' +
          '<h3>搭子服务没连上</h3><p>' + App.util.escapeHtml(this.error.message || '请确认后端已启动') + '</p></div>';
        return;
      }

      if (!this.items.length) {
        box.innerHTML =
          '<div class="buddy-empty"><div class="emoji">🧑‍🤝‍🧑</div>' +
          '<h3>还没有饭搭子</h3>' +
          '<p>添加一位常一起吃饭的朋友，抽店时就能算上 TA 的距离与口味。</p>' +
          '<button class="btn-outline" id="buddyEmptyAdd" type="button">添加第一个</button></div>';
        const btn = document.getElementById('buddyEmptyAdd');
        if (btn) btn.addEventListener('click', () => this.openAdd());
        return;
      }

      box.innerHTML = '';
      this.items.forEach((buddy) => {
        const row = document.createElement('div');
        row.className = 'buddy-row';
        const cuisines = (buddy.cuisines || []).slice(0, 3).map((name) => '#' + name).join(' ');
        const meta = [
          buddy.area || '区域未填',
          buddy.budget ? '人均 ¥' + buddy.budget : '预算未填',
          buddy.lastMet ? '上次 ' + buddy.lastMet : '还没约过'
        ].join(' · ');
        const tags =
          (buddy.source === 'invite' ? '<span class="buddy-tag">邀请加入</span>' : '') +
          ((buddy.completeness || 0) < 1 ? '<span class="buddy-tag buddy-tag--warn">资料待完善</span>' : '');
        row.innerHTML =
          '<span class="buddy-avatar" style="background:' + App.util.escapeHtml(buddy.avatarColor || '#FFE3C7') + '">' +
          App.util.escapeHtml((buddy.name || '搭').slice(0, 1)) + '</span>' +
          '<div class="buddy-info">' +
          '<div class="buddy-name">' + App.util.escapeHtml(buddy.name) + tags + '</div>' +
          '<div class="buddy-meta">' + App.util.escapeHtml(meta) + '</div>' +
          (cuisines ? '<div class="buddy-cuisines">' + App.util.escapeHtml(cuisines) + '</div>' : '') +
          '</div>' +
          '<div class="buddy-ops">' +
          '<button class="icon-btn icon-btn--xs" data-act="edit" type="button" aria-label="编辑资料">✎</button>' +
          '<button class="icon-btn icon-btn--xs" data-act="dice" type="button" aria-label="和 TA 掷骰子">' +
          '<svg class="ico"><use href="#i-dice"></use></svg></button>' +
          '<button class="icon-btn icon-btn--xs" data-act="del" type="button" aria-label="删除">✕</button>' +
          '</div>';

        row.querySelector('[data-act="edit"]').addEventListener('click', () => this.openEdit(buddy));
        row.querySelector('[data-act="dice"]').addEventListener('click', () => {
          this.selectedId = buddy.id;
          this.switchTab('dice');
          this.renderDicePick();
        });
        row.querySelector('[data-act="del"]').addEventListener('click', () => this.remove(buddy));
        box.appendChild(row);
      });
    },

    renderDicePick() {
      const box = document.getElementById('dicePick');
      if (!box) return;
      box.innerHTML = '';
      if (!this.items.length) {
        box.innerHTML = '<p class="dice-hint">还没有饭搭子，先到「饭搭子」里添加一位。</p>';
        return;
      }
      this.items.forEach((buddy) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'dice-chip' + (buddy.id === this.selectedId ? ' is-on' : '');
        chip.textContent = buddy.name;
        chip.addEventListener('click', () => {
          this.selectedId = buddy.id;
          this.renderDicePick();
        });
        box.appendChild(chip);
      });
    },

    /* ---------------- 新增 / 编辑 / 删除 ---------------- */
    openAdd() {
      this.openForm(null);
    },

    openEdit(buddy) {
      this.openForm(buddy);
    },

    openForm(buddy) {
      const editing = !!buddy;
      const state = { cuisines: editing ? (buddy.cuisines || []).slice(0, 3) : [] };

      const body = document.createElement('div');
      body.innerHTML =
        '<div class="field-label"><span>昵称</span></div>' +
        '<input id="buddyName" class="text-input" maxlength="20" placeholder="如：阿橘">' +
        '<div class="field-label" style="margin-top:14px"><span>常出没商圈</span></div>' +
        '<input id="buddyArea" class="text-input" maxlength="20" placeholder="如：望京（保存时换成坐标算距离）">' +
        '<div class="field-label" style="margin-top:14px"><span>爱吃的菜系</span></div>' +
        '<div class="area-chips" id="buddyCuisines"></div>' +
        '<div class="field-label" style="margin-top:14px"><span>人均预算</span></div>' +
        '<input id="buddyBudget" class="text-input" type="number" inputmode="numeric" min="0" max="5000" placeholder="如：120">' +
        (editing
          ? '<div class="field-label" style="margin-top:14px"><span>上次一起吃饭</span></div>' +
            '<input id="buddyLastMet" class="text-input" type="date">'
          : '') +
        '<div class="buddy-form-note" id="buddyFormNote">只保存昵称、商圈与口味；商圈会换算成坐标用于算距离，不上传通讯录。</div>';

      body.querySelector('#buddyName').value = editing ? (buddy.name || '') : '';
      body.querySelector('#buddyArea').value = editing ? (buddy.area || '') : '';
      body.querySelector('#buddyBudget').value = editing && buddy.budget != null ? String(buddy.budget) : '';
      if (editing) {
        const metInput = body.querySelector('#buddyLastMet');
        metInput.value = buddy.lastMet || '';
        metInput.max = today();
      }

      if (!editing) {
        const contactsBtn = document.createElement('button');
        contactsBtn.type = 'button';
        contactsBtn.className = 'link-btn';
        contactsBtn.textContent = '从通讯录选择一位';
        contactsBtn.style.marginTop = '10px';
        const canContacts = !!(navigator.contacts && navigator.contacts.select);
        if (canContacts) {
          contactsBtn.addEventListener('click', async () => {
            try {
              const picked = await navigator.contacts.select(['name'], { multiple: false });
              if (picked && picked[0] && picked[0].name && picked[0].name[0]) {
                body.querySelector('#buddyName').value = String(picked[0].name[0]).slice(0, 20);
                body.querySelector('#buddyFormNote').textContent = '已填入你选中的联系人；只读取你勾选的那一位。';
              }
            } catch (error) {
              App.util.toast('没有选择联系人');
            }
          });
          body.appendChild(contactsBtn);
        }
      }

      const chipBox = body.querySelector('#buddyCuisines');
      CUISINE_PICKS.forEach((name) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (state.cuisines.indexOf(name) >= 0 ? ' is-on' : '');
        chip.setAttribute('aria-pressed', state.cuisines.indexOf(name) >= 0 ? 'true' : 'false');
        chip.textContent = name;
        chip.addEventListener('click', () => {
          const index = state.cuisines.indexOf(name);
          if (index >= 0) state.cuisines.splice(index, 1);
          else if (state.cuisines.length < 3) state.cuisines.push(name);
          else App.util.toast('最多选 3 个菜系');
          chip.classList.toggle('is-on', state.cuisines.indexOf(name) >= 0);
          chip.setAttribute('aria-pressed', chip.classList.contains('is-on') ? 'true' : 'false');
        });
        chipBox.appendChild(chip);
      });

      App.util.openSheet({
        title: editing ? '编辑饭搭子' : '添加饭搭子',
        subtitle: editing ? '改完保存，抽签权重会立刻按新资料计算' : '填得越全，抽搭子和推荐越准',
        body: body,
        actions: [
          { label: '取消', variant: 'ghost' },
          {
            label: '保存',
            onClick: () => {
              const name = body.querySelector('#buddyName').value.trim();
              const area = body.querySelector('#buddyArea').value.trim();
              const budgetValue = body.querySelector('#buddyBudget').value.trim();
              if (!name) {
                App.util.toast('先填个昵称');
                return false;
              }
              const payload = {
                name: name,
                area: area,
                budget: budgetValue ? Number(budgetValue) : null,
                cuisines: state.cuisines
              };
              if (editing) {
                payload.lastMet = body.querySelector('#buddyLastMet').value.trim();
              }
              this.save(editing ? buddy.id : null, payload, {
                areaChanged: !editing || area !== (buddy.area || ''),
                missingCoords: !editing || buddy.lat === null || buddy.lng === null
              });
            }
          }
        ]
      });
    },

    async save(id, payload, options) {
      const opts = options || {};
      App.util.loading(true, '正在保存…');
      let coordsOk = true;
      try {
        // 商圈 → 坐标：距离权重（40%）全靠它，所以保存前一定尝试换算一次
        if (payload.area && (opts.areaChanged || opts.missingCoords)) {
          App.util.loading(true, '正在定位商圈…');
          const place = await this.geocodeArea(payload.area);
          if (place) {
            payload.lat = place.lat;
            payload.lng = place.lng;
          } else {
            coordsOk = false;
          }
        }
        if (id) await this.call(() => API.updateBuddy(id, payload));
        else await this.call(() => API.addBuddy(payload));
        App.util.closeSheet();
        App.util.toast(id ? '已更新搭子资料' : '已加入饭搭子目录');
        if (!coordsOk) {
          App.util.toast('已保存，但「' + payload.area + '」没换算成坐标，距离权重会按中性算', 3000);
        }
        await this.refresh();
      } catch (error) {
        App.util.toast(error.message || '保存失败');
      } finally {
        App.util.loading(false);
      }
    },

    async geocodeArea(area) {
      const first = await this.tryGeocode(area, currentCity());
      const location = App.state.location || {};
      if (!first) return null;
      if (!location.lat || !location.lng) return first;
      if (distanceKm(location.lat, location.lng, first.lat, first.lng) <= 150) return first;

      // 同名地点在别的城市（「国贸」可能搜到新疆）：用当前位置反查城市再来一次
      let city = '';
      try {
        const data = await this.call(() => API.regeo(location.lat, location.lng));
        city = (data.place && data.place.city) || '';
      } catch (error) {
        city = '';
      }
      if (!city) return null;
      const retry = await this.tryGeocode(area, city);
      if (retry && distanceKm(location.lat, location.lng, retry.lat, retry.lng) <= 150) return retry;
      // 仍然对不上就宁可不写坐标，也不要把距离算到几千公里外
      return null;
    },

    async tryGeocode(area, city) {
      try {
        const data = await this.call(() => API.geocode(area, city));
        const place = data.place;
        if (place && place.lat && place.lng) return place;
      } catch (error) {
        /* 定位失败不阻断保存 */
      }
      return null;
    },

    /* 记一次见面：更新 lastMet，让「久未见面」权重真正生效 */
    async markMet(buddy) {
      try {
        const updated = await this.call(() => API.updateBuddy(buddy.id, { lastMet: today() }));
        const target = this.items.filter((item) => item.id === buddy.id)[0];
        if (target && updated.buddy) Object.assign(target, updated.buddy);
        this.renderList();
        App.util.toast('已记下这次见面，下次抽签会算上「久未见面」');
      } catch (error) {
        App.util.toast(error.message || '记录失败');
      }
    },

    remove(buddy) {
      App.util.openSheet({
        title: '移出饭搭子？',
        subtitle: buddy.name,
        body: '<p style="font-size:12.5px;color:#6B5A50;text-align:center;line-height:1.7">删除后不影响历史骰子记录。</p>',
        actions: [
          { label: '取消', variant: 'ghost' },
          {
            label: '删除',
            onClick: async () => {
              try {
                await API.deleteBuddy(buddy.id);
                App.util.toast('已移出目录');
                await this.refresh();
              } catch (error) {
                App.util.toast(error.message || '删除失败');
              }
            }
          }
        ]
      });
    },

    /* ---------------- 邀请 ---------------- */
    async openInvite() {
      if (!(await this.ensureSession())) {
        App.util.toast('身份服务没连上，暂时不能发邀请');
        return;
      }
      App.util.loading(true, '正在生成邀请链接…');
      try {
        const data = await this.call(() => API.createInvite());
        const invite = data.invite || {};
        // 覆盖后端 host 拼的链接，改用当前访问域名，保证外网可打开
        invite.url = buildInviteUrl(invite.token);
        App.util.loading(false);
        this.showInvite(invite);
      } catch (error) {
        App.util.loading(false);
        App.util.toast(error.message || '邀请生成失败');
      }
    },

    showInvite(invite) {
      const url = invite.url || '';
      const body = document.createElement('div');
      body.innerHTML =
        '<p class="invite-lead">把链接发给朋友，TA 打开后点「接受邀请」，你们就会互相出现在饭搭子目录里。</p>' +
        '<div class="invite-link" id="inviteLink">' + App.util.escapeHtml(url) + '</div>' +
        '<p class="invite-note">链接 7 天内有效，只能使用一次。微信里如果打不开，让对方点右上角「···」→「在浏览器打开」；<br>' +
        '发错人了可以点下面的「撤销」。' +
        (invite.reused ? '<br>你之前有一条未使用的邀请，这里直接复用了它。' : '') + '</p>';

      const actions = [
        {
          label: '复制链接',
          onClick: () => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(url).then(
                () => App.util.toast('链接已复制'),
                () => App.util.toast(url)
              );
            } else {
              App.util.toast(url);
            }
            return false;
          }
        }
      ];

      if (navigator.share) {
        actions.push({
          label: '分享给朋友',
          onClick: () => {
            navigator.share({
              title: '今天吃啥 · 饭搭子邀请',
              text: '来做我的饭搭子，一起决定今天吃啥',
              url: url
            }).catch(() => {});
            return false;
          }
        });
      } else {
        actions.push({ label: '知道了' });
      }

      App.util.openSheet({
        title: '邀请饭搭子',
        subtitle: '微信不提供好友列表，用链接邀请更稳妥',
        body: body,
        actions: actions
      });

      // 撤销入口单独挂在弹层底部，避免和主操作按钮混在一起误触
      const root = document.getElementById('sheetRoot');
      const sheet = root && root.querySelector('.sheet');
      if (sheet && invite.token) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'invite-revoke';
        revoke.textContent = '撤销这条邀请';
        revoke.addEventListener('click', () => this.confirmRevoke(invite));
        sheet.appendChild(revoke);
      }
    },

    confirmRevoke(invite) {
      App.util.openSheet({
        title: '撤销这条邀请？',
        subtitle: '撤销后这个链接立刻失效，对方点开会看到「邀请已被撤销」。',
        body: '<p style="font-size:12.5px;color:#6B5A50;text-align:center;line-height:1.7">已撤销的邀请不能恢复，需要重新生成。</p>',
        actions: [
          { label: '再想想', variant: 'ghost' },
          {
            label: '撤销',
            onClick: async () => {
              try {
                await this.call(() => API.revokeInvite(invite.token));
                App.util.toast('邀请已撤销');
              } catch (error) {
                App.util.toast(error.message || '撤销失败');
              }
            }
          }
        ]
      });
    },

    /* ---------------- 抽搭子 ---------------- */
    async draw() {
      if (!(await this.ensureSession())) {
        App.util.toast('身份服务没连上，抽不了搭子');
        return;
      }
      if (!this.items.length) {
        App.util.toast('先添加一个饭搭子');
        this.openAdd();
        return;
      }

      // 只有停在店铺详情页时才用这家店的坐标/菜系；离开详情页后 current 仍留在内存里，不能拿来算
      const onDetail = (window.Pager && Pager.index === 1) || App.state.page === 1;
      const item = onDetail ? App.state.current : null;
      const location = App.state.location || {};
      const payload = item
        ? { lat: item.lat, lng: item.lng, cuisine: item.cuisine, budget: item.avgPrice || null }
        : { lat: location.lat, lng: location.lng };

      App.util.loading(true, '正在按距离和口味抽搭子…');
      try {
        const data = await this.call(() => API.drawBuddy(payload));
        App.util.loading(false);
        this.lastDraw = data;
        this.showDraw(data, item);
      } catch (error) {
        App.util.loading(false);
        App.util.toast(error.message || '没抽到搭子');
      }
    },

    showDraw(data, item) {
      const util = App.util;
      const buddy = data.buddy || {};
      const breakdown = data.breakdown || {};
      const bars = [
        { key: 'proximity', label: '距离', value: breakdown.proximity },
        { key: 'cuisine', label: '口味', value: breakdown.cuisine },
        { key: 'budget', label: '预算', value: breakdown.budget },
        { key: 'recency', label: '久未见面', value: breakdown.recency }
      ].map((row) => {
        const pct = Math.round((row.value || 0) * 100);
        return '<div class="bar-row"><span>' + row.label + '</span>' +
          '<div class="bar-track"><i style="width:' + pct + '%"></i></div>' +
          '<b>' + pct + '</b></div>';
      }).join('');

      const body = document.createElement('div');
      body.innerHTML =
        '<div class="draw-buddy">' +
        '<span class="buddy-avatar buddy-avatar--lg" style="background:' + util.escapeHtml(buddy.avatarColor || '#FFE3C7') + '">' +
        util.escapeHtml((buddy.name || '搭').slice(0, 1)) + '</span>' +
        '<h3>' + util.escapeHtml(buddy.name || '饭搭子') + '</h3>' +
        '<p class="draw-buddy-reason">' + util.escapeHtml(data.reason || '随机选中') + '</p>' +
        (item ? '<p class="draw-buddy-store">今天吃：' + util.escapeHtml(item.name) + '</p>' : '') +
        '</div>' +
        '<div class="bar-list">' + bars + '</div>' +
        (data.incomplete
          ? '<p class="draw-buddy-tip">TA 的资料完整度 ' + Math.round((data.completeness || 0) * 100) +
            '%，缺的部分只能按中性分算，抽中概率会被降权。补全后更容易被抽到。</p>'
          : '') +
        '<p class="draw-buddy-rule">' + util.escapeHtml(data.rule || '') + '</p>';

      if (data.incomplete) {
        const fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'link-btn';
        fix.textContent = '去补充 TA 的商圈 / 口味 / 预算';
        fix.addEventListener('click', () => {
          util.closeSheet();
          this.openEdit(buddy);
        });
        body.appendChild(fix);
      }

      App.util.openSheet({
        title: '陪你吃的是 TA',
        subtitle: '按距离、口味、预算与见面频率加权抽取',
        body: body,
        actions: [
          {
            label: '再抽一次',
            variant: 'ghost',
            onClick: () => {
              setTimeout(() => this.draw(), 220);
              return false;
            }
          },
          {
            label: '就 TA 了 · 记一次约饭',
            onClick: () => {
              // 记下这次见面 → 「久未见面」权重下次才真的会变
              this.markMet(buddy);
              this.selectedId = buddy.id;
              this.open();
              this.switchTab('dice');
              this.renderDicePick();
            }
          }
        ]
      });
    },

    /* ---------------- 骰子 ---------------- */
    async rollDice() {
      if (this.rolling) return;
      // 不再静默回落到第一位搭子：选中的那位被删了就明确提示重选
      const buddy = this.items.filter((item) => item.id === this.selectedId)[0];
      if (!buddy) {
        App.util.toast(this.items.length ? '先点一位搭子再掷' : '还没有饭搭子，先添加一位');
        return;
      }
      this.selectedId = buddy.id;

      const meFace = document.getElementById('diceMe');
      const buddyFace = document.getElementById('diceBuddy');
      const buddyName = document.getElementById('diceBuddyName');
      const resultEl = document.getElementById('diceResult');
      const btn = document.getElementById('diceRollBtn');
      if (buddyName) buddyName.textContent = buddy.name;

      this.rolling = true;
      if (btn) { btn.disabled = true; btn.textContent = '掷骰中…'; }
      if (resultEl) resultEl.textContent = '骰子还在转…';

      let data = null;
      try {
        data = await this.call(() => API.dice(buddy.id));
      } catch (error) {
        this.rolling = false;
        if (btn) { btn.disabled = false; btn.textContent = '掷骰子'; }
        if (resultEl) resultEl.textContent = error.message || '掷骰失败，再试一次';
        return;
      }

      // 动画：先随机滚动 8 帧，再落到服务端结果
      let frame = 0;
      const spin = setInterval(() => {
        frame++;
        if (meFace) meFace.textContent = String(1 + Math.floor(Math.random() * 6));
        if (buddyFace) buddyFace.textContent = String(1 + Math.floor(Math.random() * 6));
        if (frame >= 8) {
          clearInterval(spin);
          if (meFace) meFace.textContent = String(data.myRoll);
          if (buddyFace) buddyFace.textContent = String(data.buddyRoll);
          this.showDiceResult(data, resultEl);
          this.rolling = false;
          if (btn) { btn.disabled = false; btn.textContent = '再掷一次'; }
          App.util.haptic([18, 30, 18]);
          this.loadHistory();
        }
      }, 70);
    },

    showDiceResult(data, resultEl) {
      const payer = data.payer;
      let text;
      if (payer === 'aa') text = '点数差 ' + data.diff + '（≤2）· 这顿 AA 制';
      else if (payer === 'me') text = '点数差 ' + data.diff + '（≥3）· 你点数小，这顿你结账';
      else text = '点数差 ' + data.diff + '（≥3）· ' + data.buddyName + ' 点数小，TA 结账';
      if (resultEl) resultEl.textContent = text;
      const stage = document.getElementById('diceStage');
      if (stage) {
        stage.classList.toggle('is-aa', payer === 'aa');
        stage.classList.toggle('is-me', payer === 'me');
        stage.classList.toggle('is-buddy', payer === 'buddy');
      }
    },

    async loadHistory() {
      const box = document.getElementById('diceHistory');
      if (!box || !this.ready) return;
      try {
        const data = await this.call(() => API.diceHistory(8));
        const items = data.items || [];
        if (!items.length) {
          box.innerHTML = '<p class="dice-hint">还没有结账记录，掷一把试试。</p>';
          return;
        }
        box.innerHTML = '<div class="dice-history-title">最近结果</div>' + items.map((row) => {
          const payerText = row.payer === 'aa' ? 'AA' : (row.payer === 'me' ? '我付' : row.buddyName + ' 付');
          const date = String(row.createdAt || '').slice(5, 10);
          return '<div class="dice-history-row">' +
            '<span class="dh-date">' + App.util.escapeHtml(date) + '</span>' +
            '<span class="dh-name">' + App.util.escapeHtml(row.buddyName || '搭子') + '</span>' +
            '<span class="dh-score">' + row.myRoll + ' : ' + row.buddyRoll + '</span>' +
            '<span class="dh-payer">' + App.util.escapeHtml(payerText) + '</span>' +
            '</div>';
        }).join('');
      } catch (error) {
        box.innerHTML = '';
      }
    },

    /** 详情页「抽个搭子陪我吃」：先打开目录，有搭子就直接抽，没有就引导添加 */
    async askForStore() {
      await this.open();
      if (this.items.length) this.draw();
      else this.openAdd();
    }
  };

  window.Buddy = Buddy;
})();
