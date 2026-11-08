<script setup>
/**
 * 通讯录面板: 搜索加好友 / 处理申请 / 好友列表
 *
 * 一个刻意的设计: 搜到 pending_in（对方申请过我）的人，按钮是"同意"，
 * 点下去其实调用的是"发申请"接口 —— 后端在对方已申请时会把这次申请转成同意。
 * 这样前端不需要拿到 requestId 也能完成同意，少一条查询路径。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useFriendsStore } from '../stores/friends.js';
import AppIcon from './AppIcon.vue';
import UserAvatar from './UserAvatar.vue';

const emit = defineEmits(['open-chat']);

const friends = useFriendsStore();

const keyword = ref('');
const confirmingId = ref(null);
let debounceTimer = null;

// 输入停顿 320ms 再搜。每敲一个字就发请求既费流量又会乱序
// （后发先至的响应会把新关键词的结果覆盖掉）
watch(keyword, (value) => {
  clearTimeout(debounceTimer);
  if (!value.trim()) {
    friends.clearSearch();
    return;
  }
  debounceTimer = setTimeout(() => friends.search(value), 320);
});

onBeforeUnmount(() => clearTimeout(debounceTimer));

const searching = computed(() => keyword.value.trim().length > 0);

function relationAction(user) {
  switch (user.relation) {
    case 'friends':
      return { label: '发消息', kind: 'primary' };
    case 'pending_out':
      return { label: '已发送', kind: 'muted' };
    case 'pending_in':
      return { label: '同意', kind: 'primary' };
    default:
      return { label: '添加', kind: 'soft' };
  }
}

async function act(user) {
  if (user.relation === 'friends') {
    emit('open-chat', user.id);
    return;
  }
  if (user.relation === 'pending_out') return;

  try {
    await friends.sendRequest(user.id);
  } catch {
    /* store 里已经提示过了 */
  }
}

async function removeFriend(friend) {
  confirmingId.value = null;
  await friends.remove(friend.id);
}
</script>

<template>
  <div class="friends-pane">
    <header class="pane-head">
      <div class="pane-title">
        <h2>通讯录</h2>
        <button
          type="button"
          class="icon-btn"
          title="刷新"
          :disabled="friends.loading"
          @click="friends.refresh()"
        >
          <AppIcon name="refresh" :size="15" />
        </button>
      </div>
      <div class="search">
        <span class="search-icon"><AppIcon name="search" :size="14" /></span>
        <input
          v-model="keyword"
          class="input"
          type="search"
          placeholder="按用户名或邮箱找人"
          aria-label="搜索用户"
        />
        <button v-if="keyword" type="button" class="clear" title="清空" @click="keyword = ''">
          <AppIcon name="close" :size="13" />
        </button>
      </div>
    </header>

    <div class="body scroll-area">
      <!-- ── 搜索结果 ─────────────────────────────── -->
      <template v-if="searching">
        <div v-if="friends.searching" class="hint-row"><span class="spinner" /> 搜索中…</div>
        <div v-else-if="friends.searchError" class="hint-row">{{ friends.searchError }}</div>
        <div v-else-if="!friends.searchResults.length" class="empty">
          <span class="empty-icon"><AppIcon name="search" :size="20" /></span>
          <p class="empty-desc">没找到匹配的用户</p>
        </div>

        <div v-for="user in friends.searchResults" :key="user.id" class="row">
          <UserAvatar :user="user" :size="38" />
          <div class="row-main">
            <span class="row-name truncate">{{ user.username }}</span>
            <span class="row-sub truncate">{{ user.bio || '这个人很懒，什么也没写' }}</span>
          </div>
          <button
            type="button"
            class="btn btn-sm"
            :class="{
              'btn-primary': relationAction(user).kind === 'primary',
              'btn-soft': relationAction(user).kind === 'soft',
              'btn-ghost': relationAction(user).kind === 'muted',
            }"
            :disabled="relationAction(user).kind === 'muted'"
            @click="act(user)"
          >
            {{ relationAction(user).label }}
          </button>
        </div>
      </template>

      <!-- ── 好友列表 ─────────────────────────────── -->
      <template v-else>
        <section v-if="friends.incoming.length" class="section">
          <h3 class="section-title">
            新的朋友
            <span class="section-count">{{ friends.incoming.length }}</span>
          </h3>

          <div v-for="req in friends.incoming" :key="req.requestId" class="row request">
            <UserAvatar :user="req.from" :size="38" />
            <div class="row-main">
              <span class="row-name truncate">{{ req.from.username }}</span>
              <span class="row-sub">请求加你为好友</span>
            </div>
            <div class="request-actions">
              <button type="button" class="btn btn-sm btn-primary" @click="friends.accept(req.requestId)">
                同意
              </button>
              <button type="button" class="btn btn-sm btn-ghost" @click="friends.reject(req.requestId)">
                忽略
              </button>
            </div>
          </div>
        </section>

        <section class="section">
          <h3 class="section-title">
            好友
            <span class="section-count">{{ friends.friends.length }}</span>
            <span v-if="friends.onlineFriends.length" class="online-count">
              {{ friends.onlineFriends.length }} 在线
            </span>
          </h3>

          <div v-if="!friends.friends.length" class="empty">
            <span class="empty-icon"><AppIcon name="users" :size="20" /></span>
            <p class="empty-title">还没有好友</p>
            <p class="empty-desc">用上面的搜索框，按用户名或完整邮箱找人</p>
          </div>

          <div
            v-for="friend in friends.friends"
            :key="friend.id"
            class="row friend"
            role="button"
            tabindex="0"
            @click="emit('open-chat', friend.id)"
            @keydown.enter="emit('open-chat', friend.id)"
          >
            <UserAvatar :user="friend" :size="38" show-dot :online="friend.online" />
            <div class="row-main">
              <span class="row-name truncate">{{ friend.username }}</span>
              <span class="row-sub truncate" :class="{ 'is-online': friend.online }">
                {{ friend.online ? '在线' : friend.bio || '离线' }}
              </span>
            </div>

            <template v-if="confirmingId === friend.id">
              <div class="request-actions" @click.stop>
                <button type="button" class="btn btn-sm btn-danger-ghost" @click="removeFriend(friend)">
                  确认删除
                </button>
                <button type="button" class="btn btn-sm btn-ghost" @click="confirmingId = null">
                  取消
                </button>
              </div>
            </template>
            <template v-else>
              <button
                type="button"
                class="row-action"
                title="发消息"
                @click.stop="emit('open-chat', friend.id)"
              >
                <AppIcon name="chat" :size="16" />
              </button>
              <button
                type="button"
                class="row-action danger"
                title="删除好友"
                @click.stop="confirmingId = friend.id"
              >
                <AppIcon name="close" :size="15" />
              </button>
            </template>
          </div>
        </section>

        <section v-if="friends.outgoing.length" class="section">
          <h3 class="section-title">我发出的申请</h3>
          <div v-for="req in friends.outgoing" :key="req.requestId" class="row">
            <UserAvatar :user="req.to" :size="34" />
            <div class="row-main">
              <span class="row-name truncate">{{ req.to.username }}</span>
              <span class="row-sub">等待对方同意</span>
            </div>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.friends-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--surface);
  border-right: 1px solid var(--border);
}

.pane-head {
  flex: none;
  padding: 16px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 11px;
  border-bottom: 1px solid var(--border);
}

.pane-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pane-title h2 {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.search .clear {
  position: absolute;
  right: 8px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: var(--text-3);
}
.search .clear:hover {
  background: var(--surface-3);
  color: var(--text);
}

.body {
  flex: 1;
  min-height: 0;
  padding: 8px 8px 24px;
}

.section {
  margin-bottom: 14px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 8px 5px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-3);
  text-transform: uppercase;
}
.section-count {
  padding: 0 5px;
  height: 15px;
  line-height: 15px;
  border-radius: 99px;
  background: var(--surface-3);
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 10px;
}
.online-count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  color: var(--online);
  letter-spacing: 0;
  text-transform: none;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 7px;
  transition: background 0.12s var(--ease);
}
.row:hover {
  background: var(--surface-2);
}
.row.friend {
  cursor: pointer;
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.row-name {
  font-size: 13px;
  font-weight: 500;
}
.row-sub {
  font-size: 11.5px;
  color: var(--text-3);
}
.row-sub.is-online {
  color: var(--online);
}

.row-action {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  color: var(--text-3);
  opacity: 0;
  transition: opacity 0.12s var(--ease), background 0.12s var(--ease);
}
.row:hover .row-action {
  opacity: 1;
}
.row-action:hover {
  background: var(--surface-3);
  color: var(--text);
}
.row-action.danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

/* 待处理申请：唯一保留淡底色的行 —— 它确实需要被注意到 */
.request {
  background: #fdfaf2;
  border: 1px solid #ece2cb;
  margin-bottom: 5px;
}
.request:hover {
  background: #fdfaf2;
}

.request-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.hint-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 12px;
  font-size: 12.5px;
  color: var(--text-3);
}
</style>
