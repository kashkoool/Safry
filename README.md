# Safry Platform

هذا المجلد يحتوي على Backend وFrontend لمنصة سفري. يمكن فتح المجلد كاملاً في Visual Studio Code أو أي محرر يدعم Terminal. **القسم الإنجليزي أدناه (`English summary`) يحوي البدء السريع وجدول حالة التنفيذ؛ النسخة العربية الكاملة تتبعه.**

## English summary

Safry is a bilingual (Arabic/English, RTL/LTR) travel-services marketplace platform: a NestJS 12 modular monolith (`backend/`, Prisma 7, PostgreSQL) and a React 19 + Vite single-page app (`frontend/`). The full operating guide below is in Arabic; this section is the English entry point and does not replace it.

**This is an early local/development version, not a production-ready or commercially complete platform.** There is no payment integration and no public-registration abuse protection. Password change/reset, e-mail verification (sent through Resend) and membership invitations do exist, see [backend/docs/auth-email-flows.md](backend/docs/auth-email-flows.md). Many planned product requirements are not implemented (see the status table).

### Quick start (local)

Requires Node 22.12+ and pnpm 11. Each of `backend/` and `frontend/` has its own lockfile.

```bash
pnpm install && pnpm --dir backend install && pnpm --dir frontend install
cp backend/.env.example backend/.env       # then replace every CHANGE_ME value
openssl rand -base64 48                    # JWT_ACCESS_SECRET (32+ chars; placeholders are rejected at startup)
openssl rand -base64 18                    # BOOTSTRAP_ADMIN_PASSWORD and DEMO_SEED_PASSWORD (12+ chars)
pnpm db:start                              # local Prisma Postgres (no Docker)
pnpm --dir backend prisma:generate
pnpm --dir backend db:deploy
pnpm --dir backend db:seed                 # optional demo data; refuses to run without the two passwords above
pnpm dev                                   # API + web together
```

No default passwords exist in the code or the docs: you generate your own and keep them in the git-ignored `backend/.env`. The seed refuses weak or placeholder passwords and refuses `NODE_ENV=production` unless `ALLOW_DEMO_SEED_IN_PRODUCTION=true`.

| What | Address |
|---|---|
| Web UI (Vite dev server or Docker nginx) | `http://localhost:3001` |
| API (local dev) | `http://localhost:3000/api/v1` |
| Swagger (local dev) | `http://localhost:3000/api/v1/docs` |
| Swagger (Docker) | off by default (`SWAGGER_ENABLED=false` in compose); see docs/DEPLOYMENT.md |
| Login portals | `/login/customer`, `/login/provider`, `/login/admin` |

### Docker

Only Docker Desktop (or Docker Engine with Compose v2) is needed.

```bash
cp docker.env.example .env                 # replace every CHANGE_ME value (openssl rand -base64 48)
docker compose up -d --build               # postgres + api + web
docker compose down                        # stop; add -v to also delete the database volume
```

Nothing migrates or seeds at API start: migrations are the one-off `migrate` job and the first tenant/administrator come from `pnpm --dir backend db:bootstrap` (no demo data; in Docker there is no dedicated compose service: run it through the `migrate` image, exact command in docs/DEPLOYMENT.md section 2); the demo seed is the opt-in `seed` job (profile `seed`, needs `ALLOW_DEMO_SEED_IN_PRODUCTION=true`) and must never run on a real host. Full steps: docs/DEPLOYMENT.md. Only the web port (`WEB_PORT`, default 3001) is published; the API and PostgreSQL are internal to the compose network. `backend/compose.yml` is a separate PostgreSQL-only file for development that publishes port 5432.

### Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Docker Compose deployment runbook
- [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md): target production architecture, costs and security baseline (not yet provisioned)
- [docs/CI.md](docs/CI.md): every CI workflow, when it runs, whether it is required, and how to run it locally

### Tests

```bash
pnpm --dir backend test          # backend unit tests (vitest)
pnpm --dir backend test:int      # integration tests on a throwaway PostgreSQL with RLS forced on (embedded; set TEST_DATABASE_URL to use your own server, see backend/test/README.md)
pnpm --dir backend test:routes   # route gate: fails when any registered route was not exercised by the integration suite (run after test:int)
pnpm --dir frontend test:unit     # frontend unit tests (vitest)
pnpm --dir frontend e2e          # Playwright browser tests (see frontend/README.md); the mocked-API specs need no backend
pnpm --dir backend test:business # smoke script against a RUNNING API and its database (not part of the automated suites)
pnpm --dir backend lint && pnpm --dir backend typecheck
pnpm --dir frontend lint && pnpm --dir frontend build
```

The frontend has Playwright end-to-end tests (`frontend/e2e`): real-API journeys plus mocked-API specs for the token-refresh race, administrator step-up, booking idempotency and the sessions screen; it also has a small set of Vitest unit tests (`pnpm --dir frontend test:unit`, run in CI). The tenant-isolation spec tests exactly this: RLS on every table with a tenant key, fail-closed behaviour without a tenant scope, hidden bookings/services of another tenant, cross-tenant booking and role/status changes refused, forged `x-tenant-id` ignored, and the platform-administrator guard. "Tenant isolation is tested" means that list and nothing more.

### Implementation status

Module-level status, checked against `backend/src/modules`. "Implemented" means a working function within the stated limits, not a complete commercial feature.

| Area | Status | Notes |
|---|---|---|
| Identity and access (`identity`) | Partly implemented | Login, refresh, sessions, lockout, roles, permissions, tenants and RLS isolation exist. MFA (TOTP): sign-in with a code works in the web UI; enrolment (setup/enable/disable, recovery codes) is available in the web UI under Account > Security. The web UI has a sessions screen, sends an `Idempotency-Key` on booking creation and asks for the current password (and MFA code) when granting platform administration (step-up). Password change, forgot/reset and e-mail verification exist (see [backend/docs/auth-email-flows.md](backend/docs/auth-email-flows.md)); no SSO. Tenant `settings` are stored but nothing applies them. |
| Entities (`entities`) | Minimal | Provider organizations, departments, staff and roles only. No branches, traveler profile, trip supervisor or documents. |
| CRM | Not started | No module exists in `backend/src/modules`. |
| Travel services (`travel-services`) | Partly implemented | One generic service catalog with a category column; marketplace listing; display-only currency conversion. |
| Operations (`operations`) | Partly implemented | Booking create/amend/confirm/cancel with capacity control. No trips, groups, scheduling, supervision, execution or documents. |
| Platform administration (`platform`) | Partly implemented | Platform-admin console (accounts, tenants, sessions, audit view); no audit search/export; reports are counters only. |
| Payments, invoicing, integrations | Not started | No payment, invoicing or external integrations. |

### Known limitations

The ones that most affect a reader of this README: MFA enrolment has no UI, tenant configuration is not enforced, money is stored as 32-bit minor units with one cap for every currency, server error messages are free-text Arabic translated on the client by exact string match, and "today" in the booking rules is the server's UTC date.

---


## التشغيل في Visual Studio Code

1. افتح Visual Studio Code.
2. اختر `File` ثم `Open Folder` وافتح مجلد `SAFRY PROJECT`.
3. افتح Terminal من القائمة `Terminal` ثم `New Terminal`.
4. في أول تشغيل فقط، نفّذ تثبيت حزم كل جزء:

```powershell
pnpm install
pnpm --dir backend install
pnpm --dir frontend install
```

5. شغّل قاعدة البيانات المحلية:

```powershell
pnpm db:start
```

6. شغّل الـBackend والـFrontend معاً:

```powershell
pnpm dev
```

بعد التشغيل تصبح الواجهة متاحة على `http://localhost:3001`، وSwagger المحلي على `http://localhost:3000/api/v1/docs` (معطّل في Docker افتراضياً).

بوابات الدخول المنفصلة:

- العميل/المسافر: `http://127.0.0.1:3001/login/customer`
- مقدم الخدمة وموظفو الشركة: `http://127.0.0.1:3001/login/provider`
- مدير النظام: `http://127.0.0.1:3001/login/admin`

يمكن الوصول إليها أيضاً من روابط التبديل أسفل نموذج الدخول. صفحة الدخول تختار نوع البوابة، والخادم يرفض إنشاء جلسة إذا لم يكن الحساب من الفئة المناسبة؛ أما صلاحيات العمليات نفسها فتظل مفحوصة في الخادم.

زر «English / العربية» موجود في بوابات الدخول والتسجيل ومساحات المسافر ومقدم الخدمة ومدير المنصة وإدارة الشركة. يحفظ اختيار اللغة ويزامنه بين التبويبات ويغيّر اتجاه الواجهة بين RTL وLTR. تشمل الترجمة التنقل والنماذج وتسميات الإدارة والحالات ورسائل النظام المعروفة وتنسيق التواريخ والأسعار. تسجيل الشركة يتطلب اسمين بالعربية والإنجليزية. يمكن إدخال ترجمة إنجليزية لعنوان الخدمة ووصفها ومدينتها وتفاصيلها النصية؛ المحتوى الذي أدخله المستخدم ولم تُضف ترجمته يبقى بلغته الأصلية، ولا يُترجم آلياً.

تم استبدال البيانات التجريبية بكتالوج ثنائي اللغة؛ تفاصيل الحذف والنسخة الاحتياطية والفحص في [تقرير تحديث البيانات واللغتين](docs/bilingual-and-demo-refresh.md). لا تشغّل إعادة تهيئة قاعدة البيانات لحذف البيانات التجريبية، لأنها قد تؤثر في البيانات الفعلية.

يختار المستخدم عملة **عرض** من أعلى مساحة العمل من بين TRY وSYP وSAR وUSD وEUR وEGP. يحدد مقدم الخدمة سعراً أصلياً واحداً فقط، وتظهر قيمته التقريبية بالعملة المختارة وفق أسعار الصرف المتاحة، مع بقاء قيمة الحجز المخزنة بالعملة الأصلية. هذا عرض سعر فقط؛ لا توجد بوابة دفع أو ضمان لسعر صرف عند الدفع.

لكل تسجيل دخول رموز وجلسة مستقلة. **تنتهي الجلسة تلقائياً بعد 15 دقيقة دون نشاط من المستخدم**؛ التحديث التلقائي للبيانات لا يمددها. عند الانتهاء تعود الواجهة إلى بوابة الدخول وتعرض سبب الخروج، ويرفض الخادم الرمز القديم وتجديده. لتغيير المدة، أضف `SESSION_IDLE_TIMEOUT_MINUTES=20` مثلاً إلى `backend/.env` ثم أعد تشغيل الخادم. يمكن اختيار عدد صحيح من 1 إلى 1440 دقيقة. بعد تطبيق هذا التحديث، تحتاج الجلسات المفتوحة سابقاً إلى تسجيل دخول جديد مرة واحدة.

من بوابة المسافر يمكن الضغط على «إنشاء حساب جديد»، ومن بوابة مقدم الخدمة يمكن تسجيل شركة. المسافر يدخل بعد التسجيل. الشركة الجديدة تظهر بحالة موقوفة حتى يفعّل مدير الجهة نشاطها من قسم المنشآت. **موظف الشركة لا يسجّل نفسه**؛ مدير شركته يضيفه من صفحة الموظفين، ويحدد قسمه ودوره. يستطيع مدير الشركة إنشاء أدوار وصلاحيات تخص شركته فقط من صفحة «الأدوار والصلاحيات». **هذه نسخة محلية أولية**؛ لا يوجد تحقق من البريد أو دعوات بريدية أو حماية كافية للتسجيل العام على الإنترنت بعد.

## التشغيل في Terminal منفصل لكل جزء

Backend:

```powershell
cd backend
pnpm db:local
pnpm start:dev
```

Frontend في Terminal ثانٍ:

```powershell
cd frontend
pnpm dev
```

لإيقاف قاعدة البيانات المحلية من جذر المشروع:

```powershell
pnpm db:stop
```

## الإعداد المحلي وحسابات التجربة

لا توجد كلمات مرور افتراضية في الشيفرة أو التوثيق. تُولَّد أسرارك أنت وتوضع في `backend/.env` (المنسوخ من `backend/.env.example`، وهو غير مُتتبَّع في Git):

```bash
cp backend/.env.example backend/.env
openssl rand -base64 48   # ضعه في JWT_ACCESS_SECRET (32 حرفاً على الأقل؛ يرفض التشغيل القيم النموذجية CHANGE_ME)
openssl rand -base64 18   # ضعه في BOOTSTRAP_ADMIN_PASSWORD وفي DEMO_SEED_PASSWORD (12 حرفاً على الأقل)
```

ثم شغّل البذر محلياً مرة واحدة: `pnpm --dir backend db:seed`. يرفض البذر العمل إذا كانت كلمات المرور غير مضبوطة أو أقصر من 12 حرفاً أو قيماً نموذجية، ويرفض `NODE_ENV=production` ما لم تضبط `ALLOW_DEMO_SEED_IN_PRODUCTION=true` صراحة.

الحسابات المُنشأة (Tenant لجميعها: `safry`): `admin@safry.local` بكلمة `BOOTSTRAP_ADMIN_PASSWORD`، و`provider@safry.local` و`traveler@safry.local` وبقية حسابات الشركات التجريبية (`umrah`, `hotel`, `airline`, `transport`, `restaurant`, `visa`, `visit` بنطاق `@safry.local`) بكلمة `DEMO_SEED_PASSWORD`. هذه حسابات تطوير محلية فقط ويجب عدم استخدامها في بيئة الإنتاج.

## الوظائف المتاحة حالياً

### مدير النظام

اللوحة الشاملة على `http://127.0.0.1:3001/admin/accounts-permissions`. اختر «المدير» في صفحة الدخول؛ الحساب المحلي `admin@safry.local` وكلمة مروره هي `BOOTSTRAP_ADMIN_PASSWORD` التي ضبطتها. مدير النظام مختلف عن مدير الجهة العادي. كل قسم له رابط مستقل، مثلاً `/admin/allreservations` للحجوزات و`/admin/providers` للمنشآت. الرابط وحده لا يمنح صلاحية؛ الخادم يتحقق من الدور والجهة في كل طلب.

- مشاهدة الحسابات وجميع الجهات والمنشآت والخدمات والحجوزات والجلسات وسجل العمليات، مع البحث والصفحات والتحديث الاختياري كل 30 ثانية.
- إنشاء حساب وتعديل بياناته وربطه بدور ومنشأة، وإدارة أدوار العضوية واستثناءات السماح والمنع للصلاحيات الموجودة.
- تفعيل/إيقاف/إغلاق/حذف منطقي/استعادة الحساب، وإنهاء الجلسات. لا حذف نهائي ولا إلغاء تلقائي للحجوزات.
- حفظ التغييرات في سجل تدقيق، وإبطال الجلسات عند تغيير الصلاحيات أو حالة الحساب.
- لا تعرض اللوحة كلمات المرور أو رموز الجلسات. لا يمكن للمدير حذف نفسه أو سحب صفة الإدارة من حسابه الحالي.

**ليست جميع المتطلبات منفذة**: انظر جدول حالة التنفيذ في القسم الإنجليزي أعلاه؛ وحدة CRM لم تبدأ ووحدة الكيانات (entities) محدودة (منشآت وأقسام وموظفون وأدوار فقط).

لتحديث نسخة محلية قديمة بعد تشغيل قاعدة البيانات:

```powershell
pnpm --dir backend prisma:generate
pnpm --dir backend db:deploy
pnpm --dir backend admin:bootstrap
```

الأمر الأخير يمنح صفة مدير النظام حصراً لحساب `BOOTSTRAP_ADMIN_EMAIL` الموجود والنشط والذي فعّل المصادقة الثنائية مسبقاً (مدير النظام يحتاج مصادقة ثنائية للوصول إلى واجهات المنصة). هو أمر تهيئة موثوق، وليس مساراً متاحاً للمستخدمين العاديين. لا يعيد تعيين كلمة المرور.

إذا انقطع اتصال قاعدة البيانات عند التشغيل في الخلفية، أوقف قاعدة Safry بـ `pnpm db:stop` ثم شغّلها في Terminal مستمر من مجلد `backend` باستخدام `pnpm exec prisma dev --name safry`، واتركه مفتوحاً. شغّل `pnpm dev` من جذر المشروع في Terminal آخر.

اختبارات محلية (الخادم وقاعدة البيانات يعملان لاختبار الأعمال):

```powershell
pnpm --dir backend test
pnpm --dir backend test:business
```

اختبار الأعمال ينشئ بيانات QA مؤقتة وينظف سجلاته فقط، ولا يعدّل حسابات التجربة أو حجوزات المستخدم.

### الخدمات والحجوزات

- مقدم الخدمة: إنشاء الخدمات، تعديلها، تفعيلها أو إيقافها، ورؤية الحجوزات الواردة وتأكيدها أو إلغاؤها.
- المسافر: البحث في الخدمات، إنشاء حجز، تعديل عدد المسافرين والملاحظات للحجوزات المعلقة، وإلغاء الحجز ومتابعة حالته.
- المدير: مشاهدة وإدارة الخدمات والحجوزات على مستوى الجهة وعرض مستخدمي الجهة وأدوارهم.
- الواجهة: تنقل فعلي بين الأقسام، بحث، إشعارات للحجوزات المعلقة، اختصارات، وصفحة ملف شخصي وصلاحيات.

### المنشآت والأقسام والموظفون

- يمكن لمدير الجهة تحديد اختصاصات كل منشأة، إنشاء أقسامها وتعديلها، وإضافة موظفين جدد وربط كل موظف بقسم ودور تشغيلي واستثناءات صلاحيات محددة.
- المنشأة الجديدة تُنشأ مع حساب مسؤول خاص بها، يستطيع إدارة منشأته فقط. مُنحت حسابات الشركات التجريبية الثمانية المعروفة في هذه النسخة المحلية دور «مسؤول المنشأة» بعد التحقق من ارتباط كل حساب بشركته، ولم تُعدّل حسابات المستخدمين الأخرى. لإعادة فحص هذه الحسابات أو منح الدور لها في نسخة محلية قديمة: `pnpm --dir backend demo:managers` للمعاينة، ثم `pnpm --dir backend demo:managers --apply` للتطبيق. يسحب التطبيق جلسات هذه الحسابات القديمة ويستلزم تسجيل الدخول مجدداً.
- لكل شاشة رابط مستقل بعد الدخول: `/workspace/organizations/ID/specialties`، و`/departments`، و`/roles`، و`/employees`، حيث `ID` معرّف المنشأة. توجد روابط الانتقال إليها من قسم المنشآت في مساحة العمل.

## الأمان والاختبارات (Backend)

- **عزل الجهات:** كل طلب مرتبط بجهة الرمز الموثّق فقط (وليس بترويسة `x-tenant-id`). الحماية على طبقتين: تقييد الاستعلامات في التطبيق، وسياسات Row-Level Security في PostgreSQL (الهجرة `0010`). المُختبَر آلياً: RLS على كل جدول له مفتاح جهة، والفشل المغلق دون جهة، وإخفاء حجوزات وخدمات جهة أخرى، ورفض الحجز وإسناد الأدوار وتغيير الحالة عبر الجهات، وتجاهل `x-tenant-id` المزوّر، وحارس مدير المنصة. مسارات `/providers` و`/organizations` عبر الجهات غير مغطاة بعد باختبار تكامل..
- **قفل الحساب:** بعد `LOGIN_MAX_ATTEMPTS` محاولات فاشلة (الافتراضي 5) يُقفل الحساب `LOGIN_LOCKOUT_MINUTES` دقيقة (الافتراضي 15).
- **المصادقة متعددة العوامل (TOTP):** `/auth/mfa/setup` ثم `/auth/mfa/enable`؛ عند التفعيل يعيد `/auth/login` تحدّياً `mfaRequired` يُكمَل عبر `/auth/mfa/verify`. أكواد الاسترداد تظهر مرة واحدة فقط. **الواجهة الأمامية تدعم إدخال رمز التحقق عند الدخول، كما يمكن التفعيل والتعطيل من الحساب > الأمان (Account > Security)، إضافة إلى API.** تغيير كلمة المرور ونسيانها وإعادة تعيينها والتحقق من البريد متوفرة، انظر [backend/docs/auth-email-flows.md](backend/docs/auth-email-flows.md).
- **البريد نفسه في أكثر من جهة:** هوية واحدة وعضوية لكل جهة. التسجيل في جهة ثانية يتطلب كلمة مرور الحساب الحالي.
- **قاعدة البيانات المحلية (`prisma dev`)** لا تدعم الكتابة بدور مقيّد، لذلك تعطّل الطبقة الثانية (RLS) تلقائياً فيها مع بقاء طبقة التطبيق. اضبط `DATABASE_RLS=on` في أي بيئة PostgreSQL حقيقية (هو الافتراضي خارج `development`).

```powershell
pnpm --dir backend test           # اختبارات الوحدة للـ Backend (بلا أعداد ثابتة)
pnpm --dir backend test:int       # اختبارات التكامل على PostgreSQL حقيقي مضمّن (يشغّل nest build أولاً)
pnpm --dir backend test:business  # اختبار الأعمال على خادم يعمل (SMOKE_API_BASE لتغيير العنوان)
pnpm --dir backend typecheck
pnpm --dir frontend test:unit     # اختبارات الوحدة للواجهة الأمامية (Vitest، تعمل في CI)
```

## التشغيل بـ Docker (على أي جهاز)

المطلوب: Docker Desktop (أو Docker Engine مع Compose v2) فقط، ولا حاجة لـ Node أو PostgreSQL.

```bash
cp docker.env.example .env      # ثم استبدل كل قيمة CHANGE_ME داخل .env (ولّد الأسرار بـ: openssl rand -base64 48)
docker compose up -d --build
```

يبني الأمر ثلاث خدمات: PostgreSQL، وواجهة API (لا تُطبّق الهجرات ولا تزرع بيانات عند التشغيل؛ الهجرات عبر المهمة المنفصلة `migrate` وأول مدير عبر `db:bootstrap`، راجع docs/DEPLOYMENT.md)، وخادم nginx للواجهة. الموقع على http://localhost:3001 وSwagger معطّل افتراضياً في Docker. في Docker تعمل طبقة RLS كاملة لأن قاعدة البيانات PostgreSQL حقيقية.

- البذر التجريبي مهمة منفصلة اختيارية (`docker compose run --rm seed`، ملف التعريف `seed`) وتتطلب `ALLOW_DEMO_SEED_IN_PRODUCTION=true` و`DEMO_SEED_PASSWORD` و`BOOTSTRAP_ADMIN_PASSWORD`. لا تشغّلها في بيئة حقيقية.
- البيانات في وحدة التخزين `safry_postgres_data`؛ الأمر `docker compose down -v` يحذفها.
- لا يُنسخ `.env` ولا بيانات قاعدة التطوير المحلية؛ للحصول على بياناتك الحالية استخدم نسخة احتياطية من القاعدة.

## License

Proprietary. Copyright (c) 2026 Louay Kashkool and Ibrahim Bonni. All rights reserved. No permission is granted to use, copy, modify, host or distribute this software; see [LICENSE](LICENSE).
