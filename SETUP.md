# AETHELGARD — SETUP GUIDE
Complete deployment in 5 steps.

---

## STEP 1: Supabase Database

1. Go to https://supabase.com → your new project
2. Open SQL Editor
3. Paste entire contents of `supabase_schema.sql`
4. Click Run
5. Go to Authentication → Users → Add User
   - Email: your email
   - Password: strong password
   - This is your admin login

---

## STEP 2: Deploy Backend to Render

1. Push this entire project to a GitHub repo
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - Root Directory: `backend`
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Add Environment Variables:
   - `SUPABASE_URL` = https://syyyiezattmsswardedr.supabase.co
   - `SUPABASE_ANON_KEY` = (your anon key)
   - `SUPABASE_SERVICE_KEY` = (your service role key)
   - `ANTHROPIC_API_KEY` = (your Anthropic key)
   - `BRIDGE_SECRET` = (generate a random 32-char string, e.g. openssl rand -hex 16)
   - `FRONTEND_URL` = https://your-netlify-app.netlify.app
   - `NODE_ENV` = production
6. Deploy — note your Render URL (e.g. https://aethelgard-backend.onrender.com)

---

## STEP 3: Deploy Frontend to Netlify

1. Go to https://netlify.com → Add New Site → Import from Git
2. Connect GitHub repo
3. Settings:
   - Base directory: `frontend`
   - Build command: `npm run build`
   - Publish directory: `frontend/build`
4. Add Environment Variables:
   - `REACT_APP_API_URL` = https://your-render-url.onrender.com
   - `REACT_APP_SUPABASE_URL` = https://syyyiezattmsswardedr.supabase.co
   - `REACT_APP_SUPABASE_ANON_KEY` = (your anon key)
5. Deploy

---

## STEP 4: Configure Supabase Auth

1. Go to Supabase → Authentication → URL Configuration
2. Set Site URL to your Netlify URL
3. Add Redirect URLs: https://your-netlify-app.netlify.app/**

---

## STEP 5: Run MT5 Bridge (Your Windows Machine)

1. Make sure MetaTrader 5 is running and logged into your XM demo account
2. Open PowerShell in the `python-bridge` folder
3. Install dependencies:
   ```
   pip install -r requirements.txt
   ```
4. Copy `.env.example` to `.env`:
   ```
   copy .env.example .env
   ```
5. Edit `.env`:
   ```
   BACKEND_URL=https://your-render-url.onrender.com
   BRIDGE_SECRET=same_secret_as_backend
   ```
6. Start the bridge:
   ```
   python bridge.py
   ```
7. You should see: ✅ Connected: [login]@[server]

---

## STEP 6: Add Your Account in Dashboard

1. Open your Netlify URL
2. Login with your Supabase credentials
3. Go to Accounts → Add Account
4. Enter your MT5 demo login, password, server
5. Wait 30 seconds → status changes to LIVE

---

## USAGE

### Generate Signals
- Click "Generate Signals" on dashboard or Signals page
- Claude AI analyzes all 4 pairs across M15/H1/H4
- Signals with confidence > 65% are auto-executed on connected accounts

### Enable Auto-Trading
- Go to Settings → Enable Auto-Trading
- Signals will auto-execute every 15 minutes

### Add Clients (Future)
- Go to Clients → Add Client
- Add their MT5 account under Accounts
- Their account will mirror your signals automatically

---

## IMPORTANT SAFETY NOTES

- ALWAYS test on DEMO account for minimum 2-4 weeks
- Default risk is 1% per trade — do not increase above 2%
- The 5% daily loss circuit breaker will halt trading automatically
- Monitor the System Log on the dashboard daily
- Never share your live account credentials

---

## SUPPORT / NEXT PHASES

Phase 2 additions (next session):
- Performance analytics with equity curve chart
- Email alerts for signals and circuit breakers
- Per-pair strategy customization
- Trade journal with AI post-trade analysis
