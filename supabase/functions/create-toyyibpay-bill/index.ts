
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function cleanPhone(value: string) {
  return value.replace(/\D/g, "");
}

function toCents(value: unknown): number | null {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) return null;

  const cents = Math.round(amount * 100);

  return Number.isSafeInteger(cents) ? cents : null;
}

function validHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(value);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({
      success: false,
      error: "Method not allowed.",
    }, 405);
  }
  if (Deno.env.get("SNNA_LIVE_CHECKOUT_ENABLED") !== "true") {
    return jsonResponse({
      success: false,
      error: "Live checkout is currently disabled.",
    }, 403);
  }
  let orderId: string | null = null;
  let billRequestStarted = false;
  let billCreated = false;
  let createdBillCode: string | null = null;
  let createdOrderNumber: string | null = null;

  try {
    // 1. Server configuration
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const toyyibSecret = Deno.env.get("TOYYIBPAY_SECRET_KEY");
    const categoryCode = Deno.env.get("TOYYIBPAY_CATEGORY_CODE");

    const returnUrl = Deno.env.get("SNNA_PAYMENT_RETURN_URL");
    const callbackUrl = Deno.env.get("SNNA_PAYMENT_CALLBACK_URL");

    if (
      !supabaseUrl ||
      !anonKey ||
      !serviceRoleKey ||
      !toyyibSecret ||
      !categoryCode
    ) {
      return jsonResponse({
        success: false,
        error: "Konfigurasi pembayaran server belum lengkap.",
      }, 500);
    }

    if (
      !validHttpsUrl(returnUrl) ||
      !validHttpsUrl(callbackUrl)
    ) {
      return jsonResponse({
        success: false,
        error: "URL return atau callback belum dikonfigurasi dengan betul.",
      }, 500);
    }

    // 2. Authenticate customer
    const authorization = req.headers.get("Authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "");

    if (!token || token === authorization) {
      return jsonResponse({
        success: false,
        error: "Sila log masuk terlebih dahulu.",
      }, 401);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: authData, error: authError } =
      await authClient.auth.getUser(token);

    if (authError || !authData.user) {
      return jsonResponse({
        success: false,
        error: "Sesi login tidak sah. Sila log masuk semula.",
      }, 401);
    }

    const user = authData.user;

    if (!user.email) {
      return jsonResponse({
        success: false,
        error: "Alamat email akaun tidak tersedia.",
      }, 400);
    }

    // 3. Validate request body
    const body = await req.json();

    const checkoutRequestId =
      String(body.checkoutRequestId || "").trim();

    if (!validUuid(checkoutRequestId)) {
      return jsonResponse({
        success: false,
        error: "ID checkout tidak sah. Sila cuba checkout semula.",
      }, 400);
    }

    const customerName = String(body.customerName || "").trim();
    const customerPhone = cleanPhone(
      String(body.customerPhone || ""),
    );

    const requestedItems = body.items;

    if (customerName.length < 2 || customerName.length > 100) {
      return jsonResponse({
        success: false,
        error: "Sila masukkan nama pelanggan yang sah.",
      }, 400);
    }

    if (!/^\d{9,15}$/.test(customerPhone)) {
      return jsonResponse({
        success: false,
        error: "Nombor telefon tidak sah.",
      }, 400);
    }

    if (
      !Array.isArray(requestedItems) ||
      requestedItems.length < 1 ||
      requestedItems.length > 20
    ) {
      return jsonResponse({
        success: false,
        error: "Senarai produk tidak sah.",
      }, 400);
    }

    // 4. Admin database client
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // 5. Check whether this checkout was already submitted
    const { data: existingOrder, error: existingError } = await admin
      .from("orders")
      .select(
        "id,order_number,total,payment_status,payment_url,customer_id",
      )
      .eq("checkout_request_id", checkoutRequestId)
      .maybeSingle();

    if (existingError) {
      throw new Error("Tidak dapat menyemak rekod checkout.");
    }

    if (existingOrder) {
      if (existingOrder.customer_id !== user.id) {
        return jsonResponse({
          success: false,
          error: "ID checkout tidak sah untuk akaun ini.",
        }, 403);
      }

      if (
        String(existingOrder.payment_status).toLowerCase() === "paid"
      ) {
        return jsonResponse({
          success: true,
          already_paid: true,
          order_number: existingOrder.order_number,
          payment_status: "paid",
          message: "Pesanan ini telah dibayar.",
        });
      }

      if (existingOrder.payment_url) {
        return jsonResponse({
          success: true,
          reused: true,
          order_id: existingOrder.id,
          order_number: existingOrder.order_number,
          payment_url: existingOrder.payment_url,
          amount: Number(existingOrder.total),
          currency: "MYR",
          payment_status: existingOrder.payment_status,
        });
      }

      return jsonResponse({
        success: false,
        manual_review_required: true,
        order_number: existingOrder.order_number,
        error:
          "Checkout ini sedang diproses atau memerlukan semakan admin. Jangan buat checkout baharu dahulu.",
      }, 409);
    }

    // 6. Validate product IDs and quantities
    const quantityMap = new Map<string, number>();

    for (const item of requestedItems) {
      const productId = String(item?.productId || "").trim();
      const quantity = Number(item?.quantity);

      if (
        !validUuid(productId) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        return jsonResponse({
          success: false,
          error: "Maklumat produk atau kuantiti tidak sah.",
        }, 400);
      }

      const newQuantity =
        (quantityMap.get(productId) || 0) + quantity;

      if (newQuantity > 10) {
        return jsonResponse({
          success: false,
          error: "Kuantiti produk melebihi had.",
        }, 400);
      }

      quantityMap.set(productId, newQuantity);
    }

    const productIds = [...quantityMap.keys()];

    // 7. Fetch authoritative product prices
    const { data: products, error: productError } = await admin
      .from("products")
      .select("id,title,price,is_active")
      .in("id", productIds);

    if (productError) {
      throw new Error("Tidak dapat menyemak produk.");
    }

    if (!products || products.length !== productIds.length) {
      return jsonResponse({
        success: false,
        error: "Satu atau lebih produk tidak ditemui.",
      }, 400);
    }

    // 8. Calculate total in integer sen
    let subtotalCents = 0;
    const orderItems = [];

    for (const product of products) {
      if (product.is_active !== true) {
        return jsonResponse({
          success: false,
          error: "Produk tidak lagi tersedia.",
        }, 400);
      }

      const priceCents = toCents(product.price);
      const quantity = quantityMap.get(product.id) || 0;

      if (
        priceCents === null ||
        !Number.isInteger(quantity) ||
        quantity < 1
      ) {
        return jsonResponse({
          success: false,
          error: "Harga atau kuantiti produk tidak sah.",
        }, 400);
      }

      const itemTotal = priceCents * quantity;

      if (!Number.isSafeInteger(itemTotal)) {
        throw new Error("Jumlah produk terlalu besar.");
      }

      subtotalCents += itemTotal;

      if (!Number.isSafeInteger(subtotalCents)) {
        throw new Error("Jumlah pesanan tidak sah.");
      }

      orderItems.push({
        product_id: product.id,
        product_title: String(product.title || "Produk Digital"),
        unit_price: priceCents / 100,
        quantity,
      });
    }

    const amountInSen = subtotalCents;
    const total = subtotalCents / 100;

    if (amountInSen <= 100) {
      return jsonResponse({
        success: false,
        error: "Jumlah pembayaran mestilah melebihi RM1.00.",
      }, 400);
    }

    // 9. Generate order number
    const randomPart = crypto.randomUUID()
      .replace(/-/g, "")
      .slice(0, 12)
      .toUpperCase();

    const orderNumber =
      "SNNA" + Date.now().toString().slice(-8) + randomPart;

    createdOrderNumber = orderNumber;

    // 10. Insert order with unique checkout request ID
    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({
        checkout_request_id: checkoutRequestId,
        order_number: orderNumber,
        customer_id: user.id,
        customer_name: customerName,
        customer_email: user.email,
        customer_phone: customerPhone,
        currency: "MYR",
        subtotal: total,
        discount: 0,
        total,
        status: "pending",
        payment_status: "pending",
        payment_provider: "toyyibpay",
      })
      .select("id,order_number,total")
      .single();

    if (orderError || !order) {
      // A concurrent request may have inserted the same ID.
      if (orderError?.code === "23505") {
        const { data: duplicate } = await admin
          .from("orders")
          .select(
            "id,order_number,total,payment_status,payment_url,customer_id",
          )
          .eq("checkout_request_id", checkoutRequestId)
          .maybeSingle();

        if (duplicate && duplicate.customer_id === user.id) {
          if (
            String(duplicate.payment_status).toLowerCase() === "paid"
          ) {
            return jsonResponse({
              success: true,
              already_paid: true,
              order_number: duplicate.order_number,
              payment_status: "paid",
            });
          }

          if (duplicate.payment_url) {
            return jsonResponse({
              success: true,
              reused: true,
              order_id: duplicate.id,
              order_number: duplicate.order_number,
              payment_url: duplicate.payment_url,
              amount: Number(duplicate.total),
              currency: "MYR",
              payment_status: duplicate.payment_status,
            });
          }
        }

        return jsonResponse({
          success: false,
          manual_review_required: true,
          error:
            "Checkout yang sama sedang diproses. Sila tunggu dan jangan hantar permintaan baharu.",
        }, 409);
      }

      throw new Error("Pesanan tidak dapat disimpan.");
    }

    orderId = order.id;

    // 11. Insert order items
    const itemsToInsert = orderItems.map((item) => ({
      ...item,
      order_id: order.id,
    }));

    const { error: itemsError } = await admin
      .from("order_items")
      .insert(itemsToInsert);

    if (itemsError) {
      throw new Error("Butiran pesanan tidak dapat disimpan.");
    }

    // 12. Prepare ToyyibPay LIVE request
    const paymentData = new URLSearchParams();

    paymentData.set("userSecretKey", toyyibSecret);
    paymentData.set("categoryCode", categoryCode);
    paymentData.set("billName", "SNNA Order");
    paymentData.set(
      "billDescription",
      "SNNA Digital Product Order",
    );
    paymentData.set("billPriceSetting", "1");
    paymentData.set("billPayorInfo", "1");
    paymentData.set("billAmount", String(amountInSen));
    paymentData.set("billTo", customerName);
    paymentData.set("billEmail", user.email);
    paymentData.set("billPhone", customerPhone);
    paymentData.set("billExternalReferenceNo", orderNumber);
    paymentData.set("billReturnUrl", returnUrl);
    paymentData.set("billCallbackUrl", callbackUrl);

    // From this point, the remote outcome may become uncertain.
    // Never automatically mark this order failed after this point.
    billRequestStarted = true;

    const paymentResponse = await fetch(
      "https://toyyibpay.com/index.php/api/createBill",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: paymentData.toString(),
        signal: AbortSignal.timeout(25000),
      },
    );

    const responseText = await paymentResponse.text();

    if (!paymentResponse.ok) {
      console.error(
        "ToyyibPay HTTP response:",
        paymentResponse.status,
        responseText.slice(0, 500),
      );

      throw new Error(
        "Keputusan ToyyibPay belum dapat dipastikan. Pesanan disimpan untuk semakan admin. Jangan cuba checkout semula.",
      );
    }

    let result: any;

    try {
      result = JSON.parse(responseText);
    } catch {
      console.error(
        "Invalid ToyyibPay response:",
        responseText.slice(0, 500),
      );

      throw new Error(
        "Respons ToyyibPay tidak dapat disahkan. Pesanan memerlukan semakan admin.",
      );
    }

    const billCodeValue = Array.isArray(result)
      ? result[0]?.BillCode
      : result?.BillCode;

    const billCode =
      typeof billCodeValue === "string"
        ? billCodeValue.trim()
        : "";

    if (!billCode || !/^[a-zA-Z0-9]+$/.test(billCode)) {
      console.error(
        "ToyyibPay response without valid BillCode:",
        responseText.slice(0, 500),
      );

      throw new Error(
        "Status penciptaan bil belum dapat dipastikan. Pesanan memerlukan semakan admin.",
      );
    }

    billCreated = true;
    createdBillCode = billCode;

    const paymentUrl =
      `https://toyyibpay.com/${encodeURIComponent(billCode)}`;

    // 13. Save payment reference
    const { data: updatedOrder, error: updateError } = await admin
      .from("orders")
      .update({
        payment_reference: billCode,
        payment_url: paymentUrl,
      })
      .eq("id", order.id)
      .eq("payment_status", "pending")
      .select("id")
      .maybeSingle();

    if (updateError || !updatedOrder) {
      console.error(
        "CRITICAL: Bill created but database update failed.",
        {
          orderNumber,
          billCode,
          orderId,
          error: updateError?.message || "No row updated",
        },
      );

      throw new Error(
        "Bil telah dicipta tetapi rekod belum dikemas kini. Jangan buat pembayaran berulang. Sila hubungi admin.",
      );
    }

    // 14. Return payment details
    return jsonResponse({
      success: true,
      order_id: order.id,
      order_number: order.order_number,
      payment_url: paymentUrl,
      amount: total,
      currency: "MYR",
      payment_status: "pending",
    });

  } catch (error) {
    console.error(
      "create-toyyibpay-bill error:",
      error instanceof Error ? error.message : error,
    );

    // Only mark failed if the ToyyibPay request was never started.
    if (orderId && !billRequestStarted) {
      const url = Deno.env.get("SUPABASE_URL");
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (url && serviceKey) {
        const admin = createClient(url, serviceKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        });

        const { error: cleanupError } = await admin
          .from("orders")
          .update({
            status: "failed",
            payment_status: "failed",
          })
          .eq("id", orderId)
          .eq("payment_status", "pending")
          .is("payment_reference", null);

        if (cleanupError) {
          console.error(
            "Unable to mark failed order:",
            cleanupError.message,
          );
        }
      }
    }

    const needsReview = billRequestStarted;

    if (needsReview) {
      console.error(
        "PAYMENT RECONCILIATION REQUIRED:",
        {
          orderNumber: createdOrderNumber,
          billCode: createdBillCode,
          orderId,
          billCreated,
        },
      );
    }

    return jsonResponse({
      success: false,
      error: error instanceof Error
        ? error.message
        : "Ralat server. Sila cuba lagi.",
      manual_review_required: needsReview,
      order_number: createdOrderNumber,
    }, needsReview ? 503 : 500);
  }
});
