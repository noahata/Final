const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const { HfInference } = require('@huggingface/inference');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = '39782137338-leo8rmrpic812o2klvsrmgk84o10d4j4.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'https://final-boss-jnl3.onrender.com/oauth2callback';

const HF_TOKEN = process.env.HF_TOKEN || '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';
const hf = new HfInference(HF_TOKEN);

const API_KEYS = [
  'AIzaSyABemoPCHktvGsGZ1R99PrbA7FTQWuTDZg',
  'AIzaSyAXzQXd0AONNgSI8E6D5_BeweMqyz4iGTg',
  'AIzaSyDjLVpU8M9VFBAuj-_pvSyDW1BbUfCjyIY'
];

const REQUIRED_TELEGRAM_CHANNEL = '@bot_Farming';
const REQUIRED_YOUTUBE_CHANNEL_ID = 'UCdXmlIXXiPuI8jEis3Ht5KQ';
const REQUIRED_YOUTUBE_CHANNEL_NAME = '@Noah_Technical';
const MAX_UPLOADS = 10;
const INVITE_BONUS = 1;
const INVITES_TO_ADD_ACCOUNT = 5;
const DEVELOPER_CONTACT = '@Ace_spy';
const MAX_FILE_SIZE_MB = 300;

const YOUR_REFERRAL_LINK = 'https://t.me/GreenAppletgBot/play?startapp=6596414316';
const YOUR_REFERRAL_CODE = '6596414316';
const SPONSOR_NAME = 'Green Apple App';

let sponsors = [{
  id: 'sponsor_1',
  name: 'Green Apple App',
  referralLink: 'https://t.me/GreenAppletgBot/play?startapp=6596414316',
  referralCode: '6596414316',
  type: 'referral',
  active: true,
  requiresVerification: true,
  verificationType: 'referral',
  createdAt: new Date().toISOString()
}];

const ADMIN_IDS = ['6596414316', '123456789'];
const userSponsorVerifications = new Map();
const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors());
app.use(session({
  secret: 'youtube_upload_secret_2024',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const userSessions = new Map();
const inviteTracker = new Map();
let isUploading = false;
let currentUploader = null;
const TEMP_DIR = '/tmp/youtube_uploads';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
let aiReady = true;

async function chatWithAI(userMessage) {
  try {
    const result = await hf.textGeneration({
      model: 'distilgpt2',
      inputs: `User: ${userMessage}\nAssistant:`,
      parameters: { max_new_tokens: 100, temperature: 0.8, do_sample: true, top_k: 50 }
    });
    let response = result.generated_text || '';
    response = response.replace(`User: ${userMessage}\nAssistant:`, '').trim();
    return response || "Got it!";
  } catch (e) {
    console.error('Chat error:', e.message);
    return "⚠️ AI error. Try again.";
  }
}

async function summarizeContent(text) {
  try {
    const result = await hf.textGeneration({
      model: 'distilgpt2',
      inputs: `Summary: ${text.substring(0, 200)}\n`,
      parameters: { max_new_tokens: 80, temperature: 0.5 }
    });
    return result.generated_text?.replace(`Summary: ${text.substring(0, 200)}\n`, '').trim() || "Summarized!";
  } catch (e) {
    return "Quick summary: " + text.substring(0, 100) + "...";
  }
}

async function getAIAdvice(topic) {
  try {
    const result = await hf.textGeneration({
      model: 'distilgpt2',
      inputs: `Advice for ${topic}:`,
      parameters: { max_new_tokens: 80, temperature: 0.7 }
    });
    return result.generated_text?.replace(`Advice for ${topic}:`, '').trim() || "Keep going!";
  } catch (e) {
    return "💡 Stay consistent and engage with your audience!";
  }
}

async function generateTitles(topic, keywords = []) {
  try {
    const result = await hf.textGeneration({
      model: 'distilgpt2',
      inputs: `Titles for ${topic}:`,
      parameters: { max_new_tokens: 80, temperature: 0.9 }
    });
    const generated = result.generated_text || '';
    const titles = generated.split('\n')
      .filter(l => l.trim().length > 5)
      .slice(0, 3)
      .map(l => l.replace(/^\d+\.\s*/, '').trim());
    return titles.length > 0 ? titles : [`${topic} - Amazing!`, `${topic} - Best Ever!`, `${topic} - Must Watch!`];
  } catch (e) {
    return [`${topic} - Best Video!`, `${topic} - Amazing!`, `${topic} - Must Watch!`];
  }
}

async function generateDescription(topic, keywords = [], title = '') {
  try {
    const result = await hf.textGeneration({
      model: 'distilgpt2',
      inputs: `Description for ${title}:`,
      parameters: { max_new_tokens: 100, temperature: 0.8 }
    });
    return result.generated_text?.replace(`Description for ${title}:`, '').trim() || `Amazing ${topic} video! Watch now! 🔥`;
  } catch (e) {
    return `🔥 Amazing ${topic} video! Subscribe for more!`;
  }
}

async function generateTags(topic, keywords = []) {
  try {
    const result = await hf.textGeneration({
      model: 'distilgpt2',
      inputs: `Tags for ${topic}:`,
      parameters: { max_new_tokens: 60, temperature: 0.7 }
    });
    const generated = result.generated_text?.replace(`Tags for ${topic}:`, '').trim() || '';
    const tags = generated.split(/\s+/).filter(t => t.startsWith('#')).slice(0, 5);
    return tags.length > 0 ? tags : [`#${topic}`, `#${topic}Video`, `#Trending`];
  } catch (e) {
    return [`#${topic}`, `#${topic}Video`, `#Trending`, `#Viral`, `#Shorts`];
  }
}

async function checkTelegramChannelMembership(userId, channelUsername) {
  try {
    const cleanChannel = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;
    const chatMember = await bot.telegram.getChatMember(cleanChannel, userId);
    return chatMember.status === 'member' || chatMember.status === 'administrator' || chatMember.status === 'creator';
  } catch (e) {
    console.log(`Channel check failed for ${cleanChannel}:`, e.message);
    return false;
  }
}

async function checkReferralVerification(userId, sponsorId) {
  const key = `${userId}_${sponsorId}`;
  return userSponsorVerifications.get(key) || false;
}

function markReferralVerified(userId, sponsorId) {
  const key = `${userId}_${sponsorId}`;
  userSponsorVerifications.set(key, {
    verified: true,
    timestamp: new Date().toISOString(),
    sponsorId: sponsorId,
    verifiedVia: 'referral'
  });
  return true;
}
app.get('/admin', (req, res) => {
  const adminId = req.query.adminId || req.session.adminId;
  if (!adminId || !ADMIN_IDS.includes(adminId)) {
    return res.send(`<html><head><title>Admin Access Denied</title></head><body style="font-family:Arial;text-align:center;padding:50px;background:#0d1117;color:#fff;"><h1 style="color:#da3633;">⛔ Access Denied</h1><p>You must be an admin to access this page.</p><p><a href="/" style="color:#58a6ff;">Go Home</a></p></body></html>`);
  }
  req.session.adminId = adminId;
  res.send(`<html><head><title>Admin Panel - Sponsor Management</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;background:#0d1117;color:#fff;padding:20px}.container{max-width:1400px;margin:0 auto}.header{display:flex;justify-content:space-between;align-items:center;padding:20px 0;border-bottom:1px solid #30363d;margin-bottom:30px;flex-wrap:wrap;gap:10px}.header h1{color:#58a6ff;font-size:2em}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:15px;margin-bottom:30px}.stat-card{background:#1c2333;padding:15px 20px;border-radius:12px;border:1px solid #30363d}.stat-card h3{color:#8b949e;font-size:12px;text-transform:uppercase}.stat-card .number{font-size:1.8em;font-weight:bold;color:#f0f6fc}.card{background:#1c2333;border-radius:12px;border:1px solid #30363d;padding:20px;margin-bottom:20px}.card h2{color:#f0f6fc;margin-bottom:15px;font-size:1.3em}.form-group{margin-bottom:15px}.form-group label{display:block;color:#8b949e;margin-bottom:5px;font-size:13px}.form-group input,.form-group select,.form-group textarea{width:100%;padding:10px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#fff;font-size:14px}.form-group input:focus,.form-group select:focus,.form-group textarea:focus{outline:none;border-color:#58a6ff}.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-weight:600;transition:all .3s;font-size:14px}.btn-primary{background:#238636;color:#fff}.btn-primary:hover{background:#2ea043}.btn-danger{background:#da3633;color:#fff}.btn-danger:hover{background:#f85149}.btn-warning{background:#d29922;color:#fff}.btn-warning:hover{background:#e3b341}.btn-secondary{background:#30363d;color:#fff}.btn-secondary:hover{background:#484f58}.btn-success{background:#238636;color:#fff}.btn-success:hover{background:#2ea043}.btn-info{background:#1f6feb;color:#fff}.btn-info:hover{background:#388bfd}.btn-sm{padding:5px 12px;font-size:12px}.btn-xs{padding:3px 8px;font-size:10px}table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #30363d}th{color:#8b949e;font-weight:600;text-transform:uppercase;font-size:11px}td{color:#f0f6fc;font-size:14px}.status-badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600}.status-active{background:#238636;color:#fff}.status-inactive{background:#da3633;color:#fff}.status-referral{background:#1f6feb;color:#fff}.status-verified{background:#238636;color:#fff}.status-unverified{background:#da3633;color:#fff}.actions{display:flex;gap:5px;flex-wrap:wrap}.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}.toast{position:fixed;top:20px;right:20px;padding:15px 25px;border-radius:8px;color:#fff;font-weight:600;z-index:1000;display:none;max-width:400px}.toast-success{background:#238636}.toast-error{background:#da3633}.toast-info{background:#1f6feb}@media(max-width:768px){.grid-2{grid-template-columns:1fr}.header{flex-direction:column;align-items:flex-start}}</style></head><body><div class="container"><div class="header"><h1>🎯 Sponsor Management</h1><div><span style="color:#8b949e;margin-right:10px;">Admin ID: ${adminId}</span><a href="/" class="btn btn-secondary btn-sm">🏠 Home</a></div></div><div class="stats"><div class="stat-card"><h3>Total Sponsors</h3><div class="number" id="totalSponsors">${sponsors.length}</div></div><div class="stat-card"><h3>Active Sponsors</h3><div class="number" id="activeSponsors">${sponsors.filter(s=>s.active).length}</div></div><div class="stat-card"><h3>Your Referrals</h3><div class="number" id="totalReferrals">${userSponsorVerifications.size}</div></div><div class="stat-card"><h3>Verified Users</h3><div class="number" id="verifiedUsers">${userSponsorVerifications.size}</div></div></div><div class="card" style="background:#1f6feb20;border-color:#1f6feb;"><h2>💰 Your Referral Link (YOU GET PAID)</h2><p style="color:#8b949e;margin-bottom:10px;">Share this link with users. When they join through your link, you get paid!</p><div style="background:#0d1117;padding:15px;border-radius:8px;word-break:break-all;"><code style="color:#58a6ff;font-size:16px;">${YOUR_REFERRAL_LINK}</code></div><div style="margin-top:10px;"><button onclick="copyReferralLink()" class="btn btn-primary">📋 Copy Link</button><a href="${YOUR_REFERRAL_LINK}" target="_blank" class="btn btn-info">🚀 Open Referral Link</a></div></div><div class="grid-2"><div class="card"><h2>➕ Add Sponsor</h2><form id="addSponsorForm"><div class="form-group"><label>Sponsor Name *</label><input type="text" id="sponsorName" placeholder="e.g., Green Apple App" required></div><div class="form-group"><label>Your Referral Link *</label><input type="url" id="referralLink" placeholder="https://t.me/.../play?startapp=YOUR_CODE" required></div><div class="form-group"><label>Referral Code</label><input type="text" id="referralCode" placeholder="Your referral code"></div><button type="submit" class="btn btn-primary">➕ Add Sponsor</button></form></div><div class="card"><h2>🔍 Verify Users</h2><div class="form-group"><label>User ID</label><input type="text" id="verifyUserId" placeholder="Enter Telegram User ID"></div><div class="form-group"><label>Sponsor</label><select id="verifySponsorId">${sponsors.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select></div><button onclick="verifyUserManually()" class="btn btn-success">✅ Verify User</button><button onclick="unverifyUser()" class="btn btn-danger" style="margin-left:10px;">❌ Unverify User</button><div id="verifyResult" style="margin-top:10px;padding:10px;border-radius:8px;display:none;"></div></div></div><div class="card"><h2>📋 All Sponsors</h2><div style="overflow-x:auto;"><table><thead><tr><th>#</th><th>Name</th><th>Referral Link</th><th>Type</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody id="sponsorTableBody">${sponsors.map((s,index)=>`<tr id="sponsor-${s.id}"><td>${index+1}</td><td><strong>${s.name}</strong></td><td><a href="${s.referralLink}" target="_blank" style="color:#58a6ff;font-size:12px;">${s.referralLink.substring(0,30)}...</a></td><td><span class="status-badge status-referral">Referral</span></td><td><span class="status-badge ${s.active?'status-active':'status-inactive'}">${s.active?'Active':'Inactive'}</span></td><td style="font-size:11px;color:#8b949e;">${new Date(s.createdAt).toLocaleDateString()}</td><td><div class="actions"><button onclick="toggleSponsor('${s.id}')" class="btn btn-warning btn-xs">${s.active?'⛔':'✅'}</button><button onclick="deleteSponsor('${s.id}')" class="btn btn-danger btn-xs">🗑️</button><button onclick="editSponsor('${s.id}')" class="btn btn-secondary btn-xs">✏️</button><a href="${s.referralLink}" target="_blank" class="btn btn-info btn-xs">🔗</a></div></td></tr>`).join('')}</tbody></table></div>${sponsors.length===0?'<p style="text-align:center;color:#8b949e;padding:20px;">No sponsors added yet.</p>':''}</div><div class="card"><h2>👥 User Referrals (YOU GET PAID FOR THESE)</h2><div style="overflow-x:auto;"><table><thead><tr><th>User ID</th><th>Sponsor</th><th>Verified</th><th>Timestamp</th><th>Actions</th></tr></thead><tbody id="verificationTableBody">${Array.from(userSponsorVerifications.entries()).map(([key,value])=>{const[userId,sponsorId]=key.split('_');const sponsor=sponsors.find(s=>s.id===sponsorId);return`<tr><td>${userId}</td><td>${sponsor?sponsor.name:'Unknown'}</td><td><span class="status-badge status-verified">✅ Verified</span></td><td style="font-size:11px;color:#8b949e;">${new Date(value.timestamp).toLocaleString()}</td><td><button onclick="removeVerification('${userId}','${sponsorId}')" class="btn btn-danger btn-xs">Remove</button></td></tr>`}).join('')}</tbody></table></div>${userSponsorVerifications.size===0?'<p style="text-align:center;color:#8b949e;padding:20px;">No referrals yet. Share your link!</p>':''}</div></div><div id="toast" class="toast"></div><script>function copyReferralLink(){const link='${YOUR_REFERRAL_LINK}';navigator.clipboard.writeText(link).then(()=>{showToast('✅ Referral link copied!','success')}).catch(()=>{const textarea=document.createElement('textarea');textarea.value=link;document.body.appendChild(textarea);textarea.select();document.execCommand('copy');document.body.removeChild(textarea);showToast('✅ Referral link copied!','success')})}document.getElementById('addSponsorForm').addEventListener('submit',async(e)=>{e.preventDefault();const name=document.getElementById('sponsorName').value.trim();const referralLink=document.getElementById('referralLink').value.trim();const referralCode=document.getElementById('referralCode').value.trim();if(!name||!referralLink){showToast('Please fill all required fields!','error');return}try{const response=await fetch('/api/sponsors',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,referralLink,referralCode,adminId:'${adminId}'})});const data=await response.json();if(data.success){showToast('✅ Sponsor added successfully!','success');document.getElementById('sponsorName').value='';document.getElementById('referralLink').value='';document.getElementById('referralCode').value='';refreshList()}else{showToast('❌ Error: '+data.message,'error')}}catch(error){showToast('❌ Error: '+error.message,'error')}});async function toggleSponsor(id){try{const response=await fetch(`/api/sponsors/${id}/toggle`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminId:'${adminId}'})});const data=await response.json();if(data.success){showToast('✅ Sponsor toggled!','success');refreshList()}else{showToast('❌ Error: '+data.message,'error')}}catch(error){showToast('❌ Error: '+error.message,'error')}}async function deleteSponsor(id){if(!confirm('Are you sure you want to delete this sponsor?'))return;try{const response=await fetch(`/api/sponsors/${id}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminId:'${adminId}'})});const data=await response.json();if(data.success){showToast('✅ Sponsor deleted!','success');refreshList()}else{showToast('❌ Error: '+data.message,'error')}}catch(error){showToast('❌ Error: '+error.message,'error')}}function editSponsor(id){const newName=prompt('Enter new sponsor name:');if(newName&&newName.trim()){updateSponsorField(id,'name',newName.trim())}const newLink=prompt('Enter new referral link:');if(newLink!==null&&newLink.trim()){updateSponsorField(id,'referralLink',newLink.trim())}}async function updateSponsorField(id,field,value){try{const response=await fetch(`/api/sponsors/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({[field]:value,adminId:'${adminId}'})});const data=await response.json();if(data.success){showToast('✅ Updated!','success');refreshList()}else{showToast('❌ Error: '+data.message,'error')}}catch(error){showToast('❌ Error: '+error.message,'error')}}async function verifyUserManually(){const userId=document.getElementById('verifyUserId').value.trim();const sponsorId=document.getElementById('verifySponsorId').value;const resultDiv=document.getElementById('verifyResult');if(!userId){resultDiv.style.display='block';resultDiv.style.background='#da3633';resultDiv.style.color='#fff';resultDiv.textContent='❌ Please enter a User ID';return}try{const response=await fetch('/api/verify-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,sponsorId,adminId:'${adminId}'})});const data=await response.json();resultDiv.style.display='block';if(data.success){resultDiv.style.background='#238636';resultDiv.style.color='#fff';resultDiv.textContent='✅ User verified successfully!';refreshList()}else{resultDiv.style.background='#da3633';resultDiv.style.color='#fff';resultDiv.textContent='❌ '+data.message}}catch(error){resultDiv.style.display='block';resultDiv.style.background='#da3633';resultDiv.style.color='#fff';resultDiv.textContent='❌ Error: '+error.message}}async function unverifyUser(){const userId=document.getElementById('verifyUserId').value.trim();const sponsorId=document.getElementById('verifySponsorId').value;const resultDiv=document.getElementById('verifyResult');if(!userId){resultDiv.style.display='block';resultDiv.style.background='#da3633';resultDiv.style.color='#fff';resultDiv.textContent='❌ Please enter a User ID';return}try{const response=await fetch('/api/unverify-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,sponsorId,adminId:'${adminId}'})});const data=await response.json();resultDiv.style.display='block';if(data.success){resultDiv.style.background='#d29922';resultDiv.style.color='#fff';resultDiv.textContent='✅ User unverified!';refreshList()}else{resultDiv.style.background='#da3633';resultDiv.style.color='#fff';resultDiv.textContent='❌ '+data.message}}catch(error){resultDiv.style.display='block';resultDiv.style.background='#da3633';resultDiv.style.color='#fff';resultDiv.textContent='❌ Error: '+error.message}}async function removeVerification(userId,sponsorId){if(!confirm(`Remove verification for user ${userId}?`))return;try{const response=await fetch('/api/unverify-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,sponsorId,adminId:'${adminId}'})});const data=await response.json();if(data.success){showToast('✅ Verification removed!','success');refreshList()}else{showToast('❌ Error: '+data.message,'error')}}catch(error){showToast('❌ Error: '+error.message,'error')}}async function toggleAllSponsors(active){if(!confirm(`${active?'Activate':'Deactivate'} all sponsors?`))return;try{const response=await fetch('/api/sponsors/toggle-all',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({active,adminId:'${adminId}'})});const data=await response.json();if(data.success){showToast(`✅ All sponsors ${active?'activated':'deactivated'}!`,'success');refreshList()}else{showToast('❌ Error: '+data.message,'error')}}catch(error){showToast('❌ Error: '+error.message,'error')}}async function refreshList(){try{const response=await fetch('/api/sponsors');const data=await response.json();if(data.success){const sponsors=data.sponsors;const tbody=document.getElementById('sponsorTableBody');tbody.innerHTML=sponsors.map((s,index)=>`<tr id="sponsor-${s.id}"><td>${index+1}</td><td><strong>${s.name}</strong></td><td><a href="${s.referralLink}" target="_blank" style="color:#58a6ff;font-size:12px;">${s.referralLink.substring(0,30)}...</a></td><td><span class="status-badge status-referral">Referral</span></td><td><span class="status-badge ${s.active?'status-active':'status-inactive'}">${s.active?'Active':'Inactive'}</span></td><td style="font-size:11px;color:#8b949e;">${new Date(s.createdAt).toLocaleDateString()}</td><td><div class="actions"><button onclick="toggleSponsor('${s.id}')" class="btn btn-warning btn-xs">${s.active?'⛔':'✅'}</button><button onclick="deleteSponsor('${s.id}')" class="btn btn-danger btn-xs">🗑️</button><button onclick="editSponsor('${s.id}')" class="btn btn-secondary btn-xs">✏️</button><a href="${s.referralLink}" target="_blank" class="btn btn-info btn-xs">🔗</a></div></td></tr>`).join('');document.getElementById('totalSponsors').textContent=sponsors.length;document.getElementById('activeSponsors').textContent=sponsors.filter(s=>s.active).length;const verResponse=await fetch('/api/verifications');const verData=await verResponse.json();if(verData.success){const vtbody=document.getElementById('verificationTableBody');const verifications=verData.verifications;vtbody.innerHTML=Object.entries(verifications).map(([key,value])=>{const[userId,sponsorId]=key.split('_');const sponsor=sponsors.find(s=>s.id===sponsorId);return`<tr><td>${userId}</td><td>${sponsor?sponsor.name:'Unknown'}</td><td><span class="status-badge status-verified">✅ Verified</span></td><td style="font-size:11px;color:#8b949e;">${new Date(value.timestamp).toLocaleString()}</td><td><button onclick="removeVerification('${userId}','${sponsorId}')" class="btn btn-danger btn-xs">Remove</button></td></tr>`}).join('');document.getElementById('verifiedUsers').textContent=Object.keys(verifications).length;document.getElementById('totalReferrals').textContent=Object.keys(verifications).length}}}catch(error){showToast('❌ Error refreshing: '+error.message,'error')}}function exportSponsors(){fetch('/api/sponsors/export').then(res=>res.json()).then(data=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`sponsors_${new Date().toISOString().split('T')[0]}.json`;a.click();showToast('✅ Exported successfully!','success')}).catch(err=>showToast('❌ Export failed: '+err.message,'error'))}function importSponsors(){const input=document.createElement('input');input.type='file';input.accept='.json';input.onchange=async(e)=>{const file=e.target.files[0];if(!file)return;const reader=new FileReader();reader.onload=async(event)=>{try{const data=JSON.parse(event.target.result);const response=await fetch('/api/sponsors/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sponsors:data,adminId:'${adminId}'})});const result=await response.json();if(result.success){showToast(`✅ Imported ${data.length} sponsors!`,'success');refreshList()}else{showToast('❌ Import failed: '+result.message,'error')}}catch(err){showToast('❌ Invalid file format!','error')}};reader.readAsText(file)};input.click()}function showToast(message,type){const toast=document.getElementById('toast');toast.textContent=message;toast.className='toast toast-'+type;toast.style.display='block';setTimeout(()=>{toast.style.display='none'},3000)}setInterval(refreshList,30000);</script></body></html>`);
});
