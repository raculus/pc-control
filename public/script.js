let currentPcId = null;

// 최근 부팅 시점(last_booted_at)으로부터 현재까지 사용한 시간을 계산하는 함수
function calcUsedTime(lastBootedAt, isOnline) {
  if (!isOnline || !lastBootedAt) return "0시간 0분";
  
  const bootDate = new Date(lastBootedAt);
  const nowDate = new Date();
  const diffMs = nowDate - bootDate;

  if (diffMs <= 0 || isNaN(diffMs)) return "0시간 0분";

  const totalMinutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours}시간 ${minutes}분`;
}

// 24시간 00분 초과 금지 실시간 검증 함수
function validateTimeInput(hoursId, minutesId) {
  const hInput = document.getElementById(hoursId);
  const mInput = document.getElementById(minutesId);

  if (!hInput || !mInput) return;

  let hours = parseInt(hInput.value) || 0;
  let minutes = parseInt(mInput.value) || 0;

  if (hours > 24) {
    hInput.value = 24;
    mInput.value = 0;
  } else if (hours === 24 && minutes > 0) {
    mInput.value = 0;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const savedPw = localStorage.getItem('admin_password');
  if (savedPw) {
    document.getElementById('password').value = savedPw;
    document.getElementById('remember-me').checked = true;
    login(savedPw);
  }
});

async function login(pwOverride) {
  const password = pwOverride || document.getElementById('password').value;
  const remember = document.getElementById('remember-me').checked;

  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });

  if (res.ok) {
    if (remember) localStorage.setItem('admin_password', password);
    document.getElementById('login-section').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    document.getElementById('header-actions').style.display = 'block';
    loadPcs();
    setInterval(loadPcs, 10000); // 10초마다 상태 동기화
  } else {
    alert('비밀번호 불일치');
    localStorage.removeItem('admin_password');
  }
}

function logout() {
  localStorage.removeItem('admin_password');
  location.reload();
}

// 부모 화면: PC 목록 카드 갱신
async function loadPcs() {
  const res = await fetch('/api/pcs');
  if (!res.ok) return;
  const pcs = await res.json();

  const grid = document.getElementById('pc-grid');
  grid.innerHTML = '';

  pcs.forEach(pc => {
    const baseMin = Math.floor(pc.remaining_seconds / 60);
    const bonusMin = Math.floor((pc.bonus_seconds || 0) / 60);
    const totalMin = baseMin + bonusMin;
    const hours = Math.floor(totalMin / 60);
    const minutes = totalMin % 60;

    const statusText = pc.is_online ? '켜짐' : '꺼짐';
    const usedTimeText = calcUsedTime(pc.last_booted_at, pc.is_online);

    const card = document.createElement('div');
    card.className = `pc-card ${pc.is_online ? 'online' : 'offline'}`;
    card.onclick = () => openDetailModal(pc.id);
    card.innerHTML = `
      <div class="pc-name"><span class="status-badge"></span>${pc.name}</div>
      <div class="pc-info">상태: ${statusText} | IP: ${pc.ip}</div>
      <div class="pc-time">남은 시간: ${hours}시간 ${minutes}분</div>
      <div class="pc-time" style="margin-top: 6px; text-align: center;">사용 시간: ${usedTimeText}</div>
    `;
    grid.appendChild(card);
  });
}

// 보너스 시간 조정 함수
async function adjustBonusTime(minutes) {
  await fetch(`/api/pcs/${currentPcId}/adjust-bonus-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes })
  });
  openDetailModal(currentPcId);
  loadPcs();
}

// 자식 화면: 특정 PC 클릭 시 상세 모달 오픈
async function openDetailModal(pcId) {
  currentPcId = pcId;
  const res = await fetch(`/api/pcs/${pcId}`);
  if (!res.ok) return;

  const data = await res.json();
  const pc = data.pc;

  document.getElementById('modal-pc-name').innerText = pc.name;
  document.getElementById('modal-pc-info').innerText = `IP: ${pc.ip} | MAC: ${pc.mac}`;

  // 기본 남은 시간 계산 및 출력 (ID: modal-base-time)
  const baseTotalMin = Math.floor((pc.remaining_seconds || 0) / 60);
  const baseH = Math.floor(baseTotalMin / 60);
  const baseM = baseTotalMin % 60;
  document.getElementById('modal-base-time').innerText = `${baseH}시간 ${baseM}분`;

  // 보너스 남은 시간 계산 및 출력 (ID: modal-bonus-time)
  const bonusTotalMin = Math.floor((pc.bonus_seconds || 0) / 60);
  const bonusH = Math.floor(bonusTotalMin / 60);
  const bonusM = bonusTotalMin % 60;
  document.getElementById('modal-bonus-time').innerText = `${bonusH}시간 ${bonusM}분`;
  document.getElementById('modal-used-time').innerText = calcUsedTime(pc.last_booted_at, pc.is_online);

  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const scheduleContainer = document.getElementById('schedule-list');
  scheduleContainer.innerHTML = '';

  if (data.schedules && Array.isArray(data.schedules)) {
    data.schedules.forEach(item => {
      const itemHours = Math.floor(item.default_minutes / 60);
      const itemMinutes = item.default_minutes % 60;

      const div = document.createElement('div');
      div.className = 'schedule-row';
      div.innerHTML = `
        <span><strong>${days[item.day_of_week]}요일</strong></span>
        <div>
          <input type="number" value="${itemHours}" id="day-h-${item.day_of_week}" min="0" max="24" oninput="validateTimeInput('day-h-${item.day_of_week}', 'day-m-${item.day_of_week}')"> 시간
          <input type="number" value="${itemMinutes}" id="day-m-${item.day_of_week}" min="0" max="59" oninput="validateTimeInput('day-h-${item.day_of_week}', 'day-m-${item.day_of_week}')"> 분
          <button onclick="updateSchedule(${item.day_of_week})">저장</button>
        </div>
      `;
      scheduleContainer.appendChild(div);
    });
  }

  document.getElementById('detail-modal').style.display = 'flex';
}

async function adjustTime(minutes) {
  await fetch(`/api/pcs/${currentPcId}/adjust-time`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes })
  });
  openDetailModal(currentPcId);
  loadPcs();
}

// 요일별 시간 수정 함수
async function updateSchedule(day_of_week) {
  let hours = parseInt(document.getElementById(`day-h-${day_of_week}`).value) || 0;
  let minutes = parseInt(document.getElementById(`day-m-${day_of_week}`).value) || 0;

  if (hours >= 24) {
    hours = 24;
    minutes = 0;
  }

  const totalMinutes = Math.min(1440, (hours * 60) + minutes);

  await fetch(`/api/pcs/${currentPcId}/update-schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day_of_week, default_minutes: totalMinutes })
  });
  alert('저장되었습니다.');
  openDetailModal(currentPcId);
}

// 일괄 시간 수정 함수
async function updateScheduleBulk() {
  let hours = parseInt(document.getElementById('bulk-hours').value) || 0;
  let minutes = parseInt(document.getElementById('bulk-minutes').value) || 0;

  if (hours >= 24) {
    hours = 24;
    minutes = 0;
  }

  const totalMinutes = Math.min(1440, (hours * 60) + minutes);

  await fetch(`/api/pcs/${currentPcId}/update-schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day_of_week: 'bulk', default_minutes: totalMinutes })
  });
  openDetailModal(currentPcId);
}

async function shutdownNow() {
  if (!confirm('이 PC를 지금 즉시 원격 종료하시겠습니까?')) return;
  const res = await fetch(`/api/pcs/${currentPcId}/shutdown-now`, { method: 'POST' });
  const data = await res.json();
  alert(data.message || '종료 요청 전달됨');
}

async function deletePc() {
  if (!confirm('이 PC를 관리 목록에서 삭제하시겠습니까?')) return;
  await fetch(`/api/pcs/${currentPcId}`, { method: 'DELETE' });
  closeModal('detail-modal');
  loadPcs();
}

async function openAddPcModal() {
  // 모달 창부터 즉시 띄우기
  document.getElementById('add-modal').style.display = 'flex';
  
  const select = document.getElementById('lan-devices');
  select.innerHTML = '<option value="">🔍 주변 장치 스캔 중...</option>';

  try {
    // URL 뒤에 v=타임스탬프를 붙여 브라우저 304 캐시 완벽 방지
    const res = await fetch(`/api/lan/devices?v=${Date.now()}`);
    if (!res.ok) throw new Error('ARP 탐색 실패');
    
    const devices = await res.json();
    
    if (Array.isArray(devices) && devices.length > 0) {
      select.innerHTML = '<option value="">-- ARP 탐색 장치 선택 --</option>';
      devices.forEach(dev => {
        select.innerHTML += `<option value="${dev.ip}|${dev.mac}">IP: ${dev.ip} (MAC: ${dev.mac})</option>`;
      });
    } else {
      select.innerHTML = '<option value="">-- 탐색된 장치 없음 (수동 입력 가능) --</option>';
    }
  } catch (err) {
    console.error('[LAN Scan Error]', err);
    select.innerHTML = '<option value="">-- 스캔 실패 (수동 입력 가능) --</option>';
  }
}

function selectLanDevice() {
  const val = document.getElementById('lan-devices').value;
  if (!val) return;
  const [ip, mac] = val.split('|');
  document.getElementById('add-ip').value = ip;
  document.getElementById('add-mac').value = mac;
}

async function saveNewPc() {
  const name = document.getElementById('add-name').value;
  const ip = document.getElementById('add-ip').value;
  const mac = document.getElementById('add-mac').value;
  const ssh_user = document.getElementById('add-ssh-user').value;
  const ssh_password = document.getElementById('add-ssh-pass').value;

  if (!name || !ip || !mac) return alert('이름, IP, MAC 주소는 필수입니다.');

  const res = await fetch('/api/pcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ip, mac, ssh_user, ssh_password })
  });

  if (res.ok) {
    closeModal('add-modal');
    loadPcs();
  } else {
    alert('등록 실패');
  }
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

// 비밀번호 변경 모달 열기
function openChangePasswordModal() {
  document.getElementById('change-current-pw').value = '';
  document.getElementById('change-new-pw').value = '';
  document.getElementById('change-new-pw-confirm').value = '';
  document.getElementById('change-pw-modal').style.display = 'flex';
}

// 비밀번호 변경 API 호출
async function changePassword() {
  const currentPassword = document.getElementById('change-current-pw').value;
  const newPassword = document.getElementById('change-new-pw').value;
  const newPasswordConfirm = document.getElementById('change-new-pw-confirm').value;

  if (!currentPassword || !newPassword) {
    return alert('현재 비밀번호와 새 비밀번호를 모두 입력하세요.');
  }

  if (newPassword !== newPasswordConfirm) {
    return alert('새 비밀번호와 비밀번호 확인이 일치하지 않습니다.');
  }

  const res = await fetch('/api/admin/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword })
  });

  const data = await res.json();

  if (res.ok) {
    alert('비밀번호가 성공적으로 변경되었습니다. 다시 로그인해 주세요.');
    closeModal('change-pw-modal');
    logout(); // 변경 후 자동 로그아웃 처리
  } else {
    alert(data.message || '비밀번호 변경 실패');
  }
}