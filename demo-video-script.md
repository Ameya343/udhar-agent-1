# Udhaar Agent: 2-minute demo video script

Three speakers: **Krish**, **Harshit**, **Sarthak**. Hinglish, about 280 spoken words, which fits 2:00 at a natural pace. Each shot lists what is on screen, what to click, and the line.

## Before you record

- Open the demo in **Chrome on a laptop**, window about 1366 px wide, zoom 90%. For the live mic in shot 2, use `prototype/dist/udhaar-agent-standalone.html` (the hosted demo link blocks the mic). Everything else works on either.
- Pick the **Gupta Kirana Store** shop at the top and click **Demo dobara shuru** right before recording, so the dates read "Aaj".
- Record the screen in one take per shot. Voice-over can be recorded separately and laid on top.
- Only say "humne baat ki" or "humne dekha" in shot 8 if the team actually spoke to shopkeepers in those areas. Otherwise use the line marked *(if no visits)*.

## Shots

| # | Time | Speaker | On screen and what to click | Line |
|---|---|---|---|---|
| 1 | 0:00–0:12 | Krish | The demo page, top. Slowly scroll the "Kiska kitna baaki" list (25 customers), then back to the phones. | "Nagpur ki ek general store 20-30 grahakon ko udhaar deti hai, har ek par 3-4 hazaar tak. Sab ek copy mein. Humne us copy ko ek agent bana diya: Udhaar Agent." |
| 2 | 0:12–0:25 | Harshit | Shopkeeper's phone. Hold the green mic and say "Sharma ji ne 340 ka saaman liya, kal denge" (or click that sample chip). The voice note, the agent's reply and the new row in the Bahi-khata appear. | "Dukaandaar ko kuch type nahi karna. Bas bolta hai, Hindi ya Hinglish mein. Agent naam, raqam aur wade ki tareekh samajhkar khata mein likh deta hai." |
| 3 | 0:25–0:40 | Harshit | Click **Agle din ➜**. Point at Sharma ji's phone (the polite reminder), then the baaki list: Pappu "Reminder 2/3", Verma ji "Reminder 3/3". | "Agle din, wade ke din, agent khud yaad dilata hai. Pehle narmi se. Teen din aur late, toh thoda sakht. Ek hafte baad dukaandaar ko bhi alert. Dukaandaar ko phone nahi karna padta." |
| 4 | 0:40–0:55 | Sarthak | On Sharma ji's phone tap **💵 Cash de diya**. Click **Dukaan band 🌙**. In the shopkeeper's phone tap ✅. Sharma ji's row turns "Clear". | "Grahak jaise chahe de: cash ya UPI, dono barabar. Cash diya toh grahak bas batata hai. Shaam ko dukaandaar ek tap mein confirm karta hai. Ghalat ho toh ❌, aur vivaad record ho jaata hai." |
| 5 | 0:55–1:10 | Sarthak | Galla Mic card: click **▶ Meena didi paise de gayi**. The ticker shows chit-chat being dropped ("chhod diya") and the jama line logged ("khate mein likha"). | "Bheed ke time dukaandaar phone bhi nahi utha sakta. Galla Mic counter ki baat sunta hai, sirf jama, udhaar, baaki wali line uthata hai, baaki sab usi waqt chhod deta hai. Koi audio save nahi hota." |
| 6 | 1:10–1:22 | Krish | Scroll to **Dukaan ka haal**: Kul baaki (about ₹31,000 across 20 customers), Late, Wasooli dar, the 14-day chart. Then click **Balaji Dairy & General** at the top: different customers, different numbers. | "30 hazaar se zyada bazaar mein, aur dukaandaar ko ek nazar mein dikhta hai: kitna baaki, kaun late, kitna wapas aaya. Aur har dukaan ka apna agent, apna alag khata." |
| 7 | 1:22–1:40 | Krish | Back to Gupta. Click Sharma ji in the baaki list. **Credit score** card shows his score. Click **Lender ne record maanga (demo)**. On Sharma ji's phone tap **Haan, share karein**. The card shows what the lender sees. | "Yahi khata grahak ka credit record ban jaata hai. Score sirf time par chukane se banta hai; cash ya UPI se fark nahi padta. Aur lender ko kuch tabhi dikhta hai jab grahak khud haan kahe. Saaman ki list ya number kabhi nahi. Ijaazat kabhi bhi wapas." |
| 8 | 1:40–1:47 | Harshit | Stay on the page. Optional lower-third text: "WhatsApp + UPI simulated in demo". | "Saaf bata dein: is demo mein WhatsApp message aur UPI payment simulated hain. Voice se khata, reminder, cash confirm, Galla Mic aur score, yeh sab asli chal raha hai." |
| 9 | 1:47–2:00 | Sarthak, then all three | End card: "Udhaar Agent" and the team names. | "Nagpur mein Sneh Nagar, Khamla, Pande Layout ki dukaanon mein humne dekha: 20-30 grahakon ka udhaar copy mein likha jaata hai, aur jo nahi chukata use dukaandaar phone karke yaad dilata hai." *(if no visits: "Nagpur mein Sneh Nagar, Khamla, Pande Layout jaisi dukaanon mein udhaar aaj bhi 20-30 grahakon ka udhaar copy mein likha jaata hai, aur jo nahi chukata use dukaandaar phone karke yaad dilata hai.")* All three: "**Nagpur ke dukaandaar do kaam karte hain: copy mein likhna aur phone karke yaad dilana. Udhaar Agent dono kar deta hai.**" |

## If Agent37 is live by shooting time

Add one sentence to shot 6, after "apna alag khata": "Har dukaan ka agent Agent37 par apne alag sandbox mein chalta hai." Show the instance's URL in the address bar for that shot. Say this only if the deploy is actually done.

## Things not to say

- Don't say audio stays on the phone. Live speech-to-text uses Chrome's speech recognition, which goes to Google's servers. The agent itself keeps no audio.
- Don't say real WhatsApp messages or real UPI money moved.
- Don't say Khatabook or OkCredit have no reminders. They have manual reminder buttons. Our difference is that the agent sends them by itself and confirms cash.
- Don't describe shopkeepers as shy or hesitant to ask for money. The problem is time: writing in the copy and phoning each customer.
