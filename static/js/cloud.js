/* 云服务接入：WorkBuddy Cloud Service（SDK 由 index.html 的 vendor 脚本注入 window.WorkBuddyCloud）
   职责：初始化客户端、登录/会话、打卡数据上云（增删查）。失败一律返回 { error }，不抛异常。 */
(function () {
  'use strict';

  const Cloud = {
    client: null,
    enabled: false,

    init() {
      const cfg = (App.boot && App.boot.cloud) || {};
      const factory = window.WorkBuddyCloud;
      if (!factory || !cfg.endpoint || !cfg.publishableKey) {
        this.enabled = false;
        return;
      }
      this.client = factory.createWorkBuddyCloud({
        endpoint: cfg.endpoint,
        oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
        publishableKey: cfg.publishableKey
      });
      this.enabled = true;
    },

    /* ---------------- 会话 ---------------- */

    async restore() {
      // 处理 WorkBuddy 网页授权回跳；普通访问仅恢复已有会话
      if (!this.enabled) return { user: null };
      try {
        const url = new URL(location.href);
        const provider = url.searchParams.get('provider');
        if (provider === 'workbuddy') {
          await this.client.auth.handleWorkBuddyCallback();
          ['code', 'state', 'provider'].forEach((key) => url.searchParams.delete(key));
          history.replaceState(null, '', url.pathname + url.search);
        }
        const session = await this.client.auth.getSession();
        const user = session && session.data && session.data.session && session.data.session.user;
        return { user: user || null };
      } catch (error) {
        return { user: null, error };
      }
    },

    /** 当前云会话的 access_token：交给后端换取本站会话 */
    async accessToken() {
      if (!this.enabled) return '';
      try {
        const session = await this.client.auth.getSession();
        const s = session && session.data && session.data.session;
        return (s && (s.access_token || s.accessToken)) || '';
      } catch (error) {
        return '';
      }
    },

    async signedIn() {
      if (!this.enabled) return false;
      const { user } = await this.restore();
      return !!user;
    },

    async signInWithWorkBuddy() {
      if (!this.enabled) return { error: { message: '云服务未配置' } };
      const { data, error } = await this.client.auth.signInWithOAuth({
        provider: 'workbuddy',
        redirectTo: location.origin + '/'
      });
      if (error) return { error };
      location.assign(data.url);
      return { data };
    },

    async signOut() {
      if (!this.enabled) return { error: null };
      try {
        await this.client.auth.signOut();
        return { error: null };
      } catch (error) {
        return { error };
      }
    },

    async ownerName() {
      if (!this.enabled) return null;
      try {
        const res = await this.client.auth.getUser();
        return (res && res.data && res.data.user && res.data.user.name) || null;
      } catch (error) {
        return null;
      }
    },

    /* ---------------- 打卡数据 ---------------- */

    async listCheckins() {
      if (!this.enabled) return { data: [], error: { message: '云服务未配置' } };
      try {
        return await this.client.database
          .from('checkins')
          .select('id, store_id, store_name, cuisine, my_rating, avg_price, revisit, day')
          .order('day', { ascending: false })
          .order('id', { ascending: false })
          .limit(500);
      } catch (error) {
        return { data: [], error };
      }
    },

    async addCheckin(record) {
      if (!this.enabled) return { error: { message: '云服务未配置' } };
      try {
        const ownerName = await this.ownerName();
        return await this.client.database
          .from('checkins')
          .insert({
            store_id: String(record.store_id || record.id || ''),
            store_name: String(record.store_name || record.name || ''),
            cuisine: record.cuisine || null,
            my_rating: record.my_rating == null ? null : Number(record.my_rating),
            avg_price: record.avg_price == null ? null : Number(record.avg_price),
            revisit: record.revisit == null ? null : !!record.revisit,
            day: String(record.day || ''),
            owner_name: ownerName
          })
          .select();
      } catch (error) {
        return { error };
      }
    },

    async removeCheckin(id) {
      if (!this.enabled) return { error: { message: '云服务未配置' } };
      try {
        return await this.client.database.from('checkins').delete().eq('id', id).select();
      } catch (error) {
        return { error };
      }
    }
  };

  window.Cloud = Cloud;
})();
