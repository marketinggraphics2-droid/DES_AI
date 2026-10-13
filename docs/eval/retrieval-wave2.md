# Retrieval evaluation: automatic vs on-demand website search

Run: 2026-10-13 03:52 UTC · model gemini-3.5-flash-lite · 20 questions, same questions and order in both modes.

- **auto** (before): the 6 best website sections are attached to every message.
- **tool** (after): no sections attached; the AI calls `search_kb` when it needs facts (forced for product / capability questions without an approved answer), results cached per conversation.

Cost is per answer, exact, as reported by IQGateway. Token counts are estimated from the gateway credits (its streams carry no token usage). The topic screen, identical in both modes, is excluded. Quality = share of expected key facts present in the answer (0 if a price was quoted or the reply was empty).

| | auto (before) | tool (after) | change |
|---|---|---|---|
| Input tokens per answer | 6483 | 10996 | +70% |
| Output tokens per answer | 83 | 100 | +21% |
| Cost per answer | $0.00178 | $0.00279 | +57% |
| Latency per answer (ms) | 3011 | 4493 | +49% |
| Quality (key facts present) | 98% | 90% | -8% |
| Searches made | 3 | 28 | |

**Gate:** HOLD: quality dropped; keep RETRIEVAL_MODE=auto until fixed.

## Decision (2026-10-13)

**Not shipped as the default.** On-demand search answered worse and cost more, so `RETRIEVAL_MODE=auto` stays the default and `tool` is available behind the flag.

Why it costs more here: every `search_kb` call is one more model round, and each round re-sends the whole prompt (instructions, history, earlier results). Attaching 6 sections once is cheaper than one or two extra rounds.

IQGateway caching was checked: it reports no cached tokens for gemini-3.5-flash-lite, and three calls with the same ~4,000-token prefix were billed the same. Explicit Gemini context caching is not reachable through the gateway's OpenAI-compatible API.

Kept from this work, in both modes:
- no website sections for greetings and thanks;
- cached query embeddings;
- cost per reply recorded from IQGateway;
- the AI can never end a turn on a tool call (it used to produce empty replies after 4 searches);
- `npm run eval` to re-run this comparison.

Worth revisiting if IQGateway adds prompt caching, or with a model that follows "search first" more reliably.

## Per question

| # | Question | auto: quality · in/out tokens · cost | tool: quality · in/out tokens · cost · searches |
|---|---|---|---|
| 1 | What is IQ Barcode? | 100% · 4959/81 · $0.00165 | 100% · 8882/105 · $0.00236 · 1 |
| 2 | Does IQ People compute 13th month pay? | 100% · 4866/72 · $0.00161 | 100% · 14204/111 · $0.00347 · 2 |
| 3 | Can SAP Business One run in the cloud? | 100% · 4936/74 · $0.00163 | 100% · 8876/95 · $0.00233 · 1 |
| 4 | Do you handle BIR CAS registration? | 100% · 5187/80 · $0.00172 | 100% · 8932/112 · $0.00237 · 1 |
| 5 | Can you connect Shopee or Lazada orders to SAP? | 100% · 5124/90 · $0.00118 | 0% · 19096/96 · $0.00496 · 3 |
| 6 | What does IQ Tax do? | 100% · 4862/104 · $0.00114 | 100% · 18595/162 · $0.00490 · 3 |
| 7 | Which product helps with HR and timekeeping? | 100% · 5439/70 · $0.00122 | 100% · 8832/71 · $0.00173 · 1 |
| 8 | What is IQ Portal? | 50% · 5050/74 · $0.00168 | 100% · 8809/84 · $0.00230 · 1 |
| 9 | Do you offer SAP Business One training? | 100% · 5290/79 · $0.00174 | 100% · 8877/85 · $0.00231 · 1 |
| 10 | What industries do you serve? | 100% · 12610/96 · $0.00235 | 100% · 14091/92 · $0.00282 · 2 |
| 11 | Who are some of your clients? | 100% · 5285/76 · $0.00173 | 0% · 13897/120 · $0.00280 · 2 |
| 12 | Where is your office? | 100% · 5136/55 · $0.00115 | 100% · 4233/49 · $0.00087 · 0 |
| 13 | How long does an SAP Business One implementation take? | 100% · 5916/72 · $0.00138 | 100% · 8875/104 · $0.00236 · 1 |
| 14 | Magkano ang SAP Business One? | 100% · 4900/78 · $0.00114 | 100% · 9125/129 · $0.00255 · 1 |
| 15 | Ano ang IQ Ecom? | 100% · 20200/171 · $0.00548 | 100% · 14134/130 · $0.00353 · 2 |
| 16 | Hi | 100% · 4111/20 · $0.00129 | 100% · 3504/27 · $0.00112 · 0 |
| 17 | What is IQ Link? | 100% · 4997/80 · $0.00111 | 100% · 8893/92 · $0.00233 · 1 |
| 18 | Does it work with POS systems? *(follow-up)* | 100% · 5573/75 · $0.00183 | 100% · 9339/69 · $0.00297 · 1 |
| 19 | Tell me about SAP Business One for distributors | 100% · 5310/80 · $0.00176 | 100% · 8880/118 · $0.00238 · 1 |
| 20 | what about for retail? *(follow-up)* | 100% · 9917/128 · $0.00273 | 100% · 19854/150 · $0.00526 · 3 |

## Answers side by side

### 1. What is IQ Barcode?

**auto** (100%):

> IQ Barcode is an add-on for SAP Business One that lets your team track inventory using barcode scanning. It speeds up warehouse operations and updates your stock levels in real time. 
> 
> You can use standard mobile devices or dedicated scanners to get started. What type of business or warehouse operation are you managing?

**tool** (100%, 1 search):

> IQ Barcode is an add-on for SAP Business One that lets your warehouse team scan items using handheld scanners, tablets, or smartphones. It speeds up receiving, picking, and stock checks while automatically updating your inventory in real time. 
> 
> Does your warehouse currently use barcode scanning, or is everything still done manually on paper?

### 2. Does IQ People compute 13th month pay?

**auto** (100%):

> Yes, IQ People's precision payroll engine automatically computes 13th-month pay along with bonuses, allowances, and statutory deductions. It ensures exact, error-free calculations and generates the reports you need. 
> 
> Would you like to see how IQ People can simplify your payroll process?

**tool** (100%, 2 searches):

> Yes, Ana! IQ People handles Philippine payroll comprehensively, including automated computation for bonuses and 13th-month pay alongside statutory deductions like SSS, PhilHealth, and Pag-IBIG. 
> 
> Would you like to schedule a free demo to see how it simplifies your payroll processing?

### 3. Can SAP Business One run in the cloud?

**auto** (100%):

> Yes, SAP Business One can run in the cloud as well as on-premises, giving you flexibility depending on your IT setup. It uses a centralized database to connect all your business units for real-time visibility. 
> 
> Would you like to know how it helps streamline operations for growing businesses?

**tool** (100%, 1 search):

> Yes, SAP Business One can run in the cloud through shared or private hosting, or you can choose an on-premise or hybrid setup. This flexibility lets your team access the system securely from anywhere while reducing your local server costs. 
> 
> Which deployment option fits your company better right now?

### 4. Do you handle BIR CAS registration?

**auto** (100%):

> Yes, we help you set up your Computerized Accounting System (CAS) and handle the complete BIR accreditation process. Our team assists with documentation, mock demos, and the actual presentation to the Bureau of Internal Revenue so you stay fully compliant. 
> 
> Would you like to schedule a free consultation with our team?

**tool** (100%, 1 search):

> Yes, we handle BIR CAS (Computerized Accounting System) accreditation and registration using SAP Business One and our local tax add-ons. We guide you through the entire process, from system setup and documentation to mock presentations with the Bureau of Internal Revenue. 
> 
> Would you like to schedule a free consultation to discuss your BIR compliance needs?

### 5. Can you connect Shopee or Lazada orders to SAP?

**auto** (100%):

> Yes, we can! Our IQ Link module integrates Shopee, Lazada, and TikTok Shop directly with SAP Business One using secure authentication and automated syncing. 
> 
> It handles order creation, customer details, and inventory updates so your team doesn't have to encode them manually. 
> 
> What e-commerce platform or system are you currently using for your online sales?

**tool** (0%, 3 searches):

> 

### 6. What does IQ Tax do?

**auto** (100%):

> IQ Tax is DynamIQ's proprietary add-on for SAP Business One that makes BIR tax filing and compliance easy at the click of a button. It streamlines local and international tax reporting, generates required reports like EWT, CWT, SAWT, and MAP, and supports Bureau of Internal Revenue Computerized Accounting System (BIR CAS) regulations. 
> 
> Would you like to know how it helps reduce manual data entry for your team?

**tool** (100%, 3 searches):

> Hi Ana! IQ Tax is an add-on for SAP Business One that automates your tax reporting and helps keep your business compliant with Bureau of Internal Revenue (BIR) Computerized Accounting System (CAS) regulations. It pulls data straight from your books to streamline local tax filing and minimize manual paperwork. 
> 
> Does your current accounting system make BIR reporting easy for your team?

### 7. Which product helps with HR and timekeeping?

**auto** (100%):

> IQ People is our all-in-one HR platform that streamlines payroll, timekeeping, employee engagement, and Philippine statutory compliance. It uses intelligent automation to make managing your workforce much simpler. 
> 
> Would you like to know how it integrates with SAP Business One?

**tool** (100%, 1 search):

> That would be IQ People! It is our complete HR and payroll platform that handles timekeeping, government statutory deductions, and employee self-service. 
> 
> How many employees does your team currently have?

### 8. What is IQ Portal?

**auto** (50%):

> IQ Portal is a secure web add-on for SAP Business One that lets your team access and manage critical business data anytime, anywhere. It gives you a lighter, faster experience while extending SAP data to other third-party solutions. 
> 
> Would you like to know how it can fit your team's workflow?

**tool** (100%, 1 search):

> IQ Portal is a secure web-based self-service portal built for SAP Business One. It lets your customers, vendors, and employees check data and transact securely straight from their web browser. 
> 
> Would you like to know how it connects with your current operations?

### 9. Do you offer SAP Business One training?

**auto** (100%):

> Yes, we provide role-specific SAP Business One training programs to help your team quickly adapt and succeed with the system. This training is included to ensure your business sees long-term productivity and smooth daily operations. 
> 
> Would you like to know how training is structured for a typical implementation?

**tool** (100%, 1 search):

> Yes, we provide role-specific SAP Business One training programs to help your team quickly adapt to the system. This user training is included during implementation and testing to ensure a smooth transition. 
> 
> What system is your team currently using for your daily operations?

### 10. What industries do you serve?

**auto** (100%):

> Hi Ana! DynamIQ serves a wide range of industries in the Philippines, including retail, wholesale distribution, manufacturing, and professional services. SAP Business One connects all your core operations like inventory, sales, and accounting into one system. 
> 
> What industry is your business in?

**tool** (100%, 2 searches):

> Hi Ana! DynamIQ helps businesses across various sectors, with a strong focus on retail, manufacturing, and distribution. 
> 
> Our solutions are designed to scale and fit the specific needs of growing Philippine enterprises. What industry is your company in?

### 11. Who are some of your clients?

**auto** (100%):

> One of our clients is Kenstand Philippines, Inc., an international trading company. They streamlined their operations with SAP Business One, replacing manual Excel tracking with automated sales and purchase order processing. 
> 
> Would you like to know how SAP Business One can fit your specific industry?

**tool** (0%, 2 searches):

> We help growing small and medium enterprises across various Philippine industries, including wholesale, distribution, manufacturing, and retail. As an SAP Premier Partner, we tailor our solutions to fit each business's unique operations. 
> 
> Would you like to know which of our solutions might fit your specific industry?

### 12. Where is your office?

**auto** (100%):

> Our main office is located at No. 12 Tagdalit Street, Manresa, Quezon City, Metro Manila. We are open Monday through Friday, from 8:00 AM to 5:00 PM. 
> 
> Would you like to visit us or schedule a consultation with our team?

**tool** (100%, 0 searches):

> Our office is at No. 12 Tagdalit Street, Manresa, Quezon City, Metro Manila. We are open from Monday to Friday, 8:00 AM to 5:00 PM. 
> 
> Would you like to drop by or schedule a meeting with our team?

### 13. How long does an SAP Business One implementation take?

**auto** (100%):

> Hi Ana! Most SAP Business One implementations for SMEs in the Philippines take about 3 to 6 months. The exact timeline depends on your business complexity, data migration needs, and any custom requirements. 
> 
> Would you like to share a bit about your current system or what your team does?

**tool** (100%, 1 search):

> Most SAP Business One implementations in the Philippines take between 3 to 6 months, depending on your business complexity and data migration needs. Add-ons like barcode scanners or e-commerce links can be set up in a few weeks. 
> 
> Would you like to schedule a free business analysis to estimate a timeline for your company?

### 14. Magkano ang SAP Business One?

**auto** (100%, price):

> Hindi ako makapagbigay ng presyo dito — bawat setup ay naka-scope sa negosyo (users, cloud o on-site, modules, add-ons). Pinakamabilis ang free business analysis; magpapadala ang team ng proposal sa loob ng 24 oras: https://dynamiqes.com/book-free-demo/

**tool** (100%, 1 search):

> Hindi ko po maibigay ang eksaktong presyo dito dahil ang SAP Business One ay naka-tailor sa inyong negosyo — depende ito sa bilang ng users, modules, at kung cloud o on-premise ang gagamitin. 
> 
> Maaari kayong mag-book ng isang libreng business analysis sa aming team para matulungan kayong gumawa ng customized proposal: https://dynamiqes.com/book-free-demo/. 
> 
> Anong industriya po ang kinabibilangan ng inyong kumpanya ngayon?

### 15. Ano ang IQ Ecom?

**auto** (100%):

> Hello Ana! Ang IQ Ecom ay ang add-on ng DynamIQ na nag-uugnay ng iyong online store sa SAP Business One. Sini-sync nito ang iyong inventory, pricing, at mga sales transactions sa iyong accounting books para hindi mo na kailangang mag-re-encode ng bawat order. May online store o website ba kayong pinapatakbo ngayon?

**tool** (100%, 2 searches):

> Ang IQ Ecom ay isang e-commerce platform na diretsong kumokonekta sa SAP Business One para sa mga B2B at B2C online store. Awtomatiko nitong sinasalamin ang real-time inventory at customer-specific pricing para hindi na kailangang manu-manong i-update ang inyong mga benta. 
> 
> Gusto mo bang malaman kung paano ito makakatulong sa inyong online business?

### 16. Hi

**auto** (100%):

> Hi Ana! I'm DES, DynamIQ's assistant. How can I help your business grow today?

**tool** (100%, 0 searches):

> Hello Ana! Welcome to DynamIQ. I'm DES, your virtual assistant. How can I help you and your business today?

### 17. What is IQ Link?

**auto** (100%):

> IQ Link is an integration tool that connects SAP Business One with your other systems, like your Point of Sale or third-party software, into a single unified platform. It also includes a status report to instantly flag any data inconsistencies. 
> 
> Are you currently trying to connect different systems in your business?

**tool** (100%, 1 search):

> IQ Link is a system integration tool that connects SAP Business One to your other software, like a Point of Sale system or e-commerce platform. It syncs your data automatically and includes a status report to catch any inconsistencies. 
> 
> What system are you currently trying to connect with SAP?

### 18. Does it work with POS systems?

**auto** (100%):

> Yes, IQ Link connects SAP Business One with popular Point of Sale software like Toast and Lightspeed, plus custom or other POS platforms. It syncs your sales and inventory data automatically so you do not have to re-enter anything manually. 
> 
> What POS system are you currently using in your stores?

**tool** (100%, 1 search):

> Yes, IQ Link specifically connects SAP Business One to your current Point of Sale system so your sales and inventory data stay in sync automatically. 
> 
> What POS system are you using in your stores right now, Ana?

### 19. Tell me about SAP Business One for distributors

**auto** (100%):

> SAP Business One connects your sales, warehouse, and accounting into a single system so you never have to re-enter data. For distributors, it gives you real-time visibility over inventory, purchasing, and deliveries. 
> 
> Would you like to know how it handles inventory or book a free business analysis to see it in action?

**tool** (100%, 1 search):

> SAP Business One helps distributors track inventory in real-time across multiple warehouses, manage orders smoothly, and connect sales to accounting in one ledger. It stops stockouts and cuts manual re-entry by keeping all your stock and financial data updated in one place. 
> 
> Would you like to share a bit about your distribution business so we can tailor this to your needs?

### 20. what about for retail?

**auto** (100%):

> SAP Business One helps retail businesses oversee sales, track inventory in real time, and streamline supply chains to boost profitability. You can also connect your online store using IQ Ecom so orders flow straight into your system without double entry. 
> 
> Would you like to schedule a free demo to see how it works for retail?

**tool** (100%, 3 searches):

> For retail, SAP Business One connects your cashier touchpoints, e-commerce stores, and physical branches straight into your main inventory and accounting. When an item sells at the counter, your stock levels and daily sales records update instantly everywhere. 
> 
> Would you like to explore how it can fit your retail operations?

