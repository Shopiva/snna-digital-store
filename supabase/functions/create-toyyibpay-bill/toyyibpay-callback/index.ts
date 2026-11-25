import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHash } from "node:crypto";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getField(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function md5(value: string): string {
  return createHash("md5")
    .update(value, "utf8")
    .digest("hex");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({
      success: false,
      message: "Method not allowed",
    }, 405);
  }

  try {
    const secretKey = Deno.env.get("TOYYIBPAY_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!secretKey || !supabaseUrl || !serviceRoleKey) {
      throw new Error("Server configuration is incomplete.");
    }

    const form = await req.formData();

    const refno = getField(form, "refno");
    const status = getField(form, "status");
    const reason = getField(form, "reason");
    const billCode = getField(form, "billcode");
    const orderNumber = getField(form, "order_id");
    const receivedHash = getField(form, "hash");

    if (
      !refno ||
      !status ||
      !billCode ||
      !orderNumber ||
      !receivedHash
    ) {
      return jsonResponse({
        success: false,
        message: "Missing callback fields",
      }, 400);
    }

    // 1. Verify callback hash
    const expectedHash = md5(
      secretKey + status + orderNumber + refno + "ok"
    );

    if (receivedHash.toLowerCase() !== expectedHash.toLowerCase()) {
      return jsonResponse({
        success: false,
        message: "Invalid callback hash",
      }, 401);
    }

    // 2. Ignore pending or unsuccessful payment
    if (status !== "1") {
      return jsonResponse({
        success: true,
        message: "Payment is not successful.",
        payment_status: status,
        reason,
      });
    }

    // 3. Create server-side Supabase client
    const supabase = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    // 4. Find matching order
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        id,
        order_number,
        total,
        payment_status,
        payment_provider,
        payment_reference
      `)
      .eq("order_number", orderNumber)
      .maybeSingle();

    if (orderError) {
      throw orderError;
    }

    if (!order) {
      return jsonResponse({
        success: false,
        message: "Order not found",
      }, 404);
    }

    if (order.payment_provider !== "toyyibpay") {
      return jsonResponse({
        success: false,
        message: "Payment provider mismatch",
      }, 400);
    }

    if (order.payment_reference !== billCode) {
      return jsonResponse({
        success: false,
        message: "Bill code mismatch",
      }, 400);
    }

    // 5. Idempotency
    if (String(order.payment_status).toLowerCase() === "paid") {
      return jsonResponse({
        success: true,
        message: "Order already paid",
        order_number: orderNumber,
      });
    }

    if (String(order.payment_status).toLowerCase() !== "pending") {
      return jsonResponse({
        success: false,
        message: "Order is not pending payment",
      }, 409);
    }

    // 6. Independently verify payment with ToyyibPay
    const transactionData = new URLSearchParams();

    transactionData.set("billCode", billCode);
    transactionData.set("userSecretKey", secretKey);
    transactionData.set("billpaymentStatus", "1");

    const transactionResponse = await fetch(
      "https://toyyibpay.com/index.php/api/getBillTransactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: transactionData.toString(),
      }
    );

    const transactionText = await transactionResponse.text();

    if (!transactionResponse.ok) {
      throw new Error(
        "Unable to verify ToyyibPay transaction."
      );
    }

    let transactions: unknown;

    try {
      transactions = JSON.parse(transactionText);
    } catch {
      throw new Error(
        "Invalid response from ToyyibPay verification API."
      );
    }

    if (!Array.isArray(transactions)) {
      throw new Error(
        "ToyyibPay transaction record is unavailable."
      );
    }

    const verifiedTransaction = transactions.find(
      (item: any) =>
        String(item.billpaymentStatus) === "1" &&
        String(item.billExternalReferenceNo) === orderNumber
    );

    if (!verifiedTransaction) {
      return jsonResponse({
        success: false,
        message: "Successful transaction could not be verified.",
      }, 409);
    }

    // 7. Verify amount
    const paidAmount = Number(
      verifiedTransaction.billpaymentAmount
    );

    const orderAmount = Number(order.total);

    if (
      !Number.isFinite(paidAmount) ||
      !Number.isFinite(orderAmount) ||
      Math.round(paidAmount * 100) !==
        Math.round(orderAmount * 100)
    ) {
      return jsonResponse({
        success: false,
        message: "Payment amount does not match the order.",
      }, 409);
    }

    // 8. Mark order paid only after verification
    const { data: updatedOrder, error: updateError } =
      await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          paid_at: new Date().toISOString(),
        })
        .eq("id", order.id)
        .eq("payment_status", "pending")
        .select("id, payment_status")
        .maybeSingle();

    if (updateError) {
      throw updateError;
    }

    // Handle duplicate callback / race condition
    if (!updatedOrder) {
      const { data: currentOrder, error: currentError } =
        await supabase
          .from("orders")
          .select("payment_status")
          .eq("id", order.id)
          .maybeSingle();

      if (currentError) {
        throw currentError;
      }

      if (
        currentOrder &&
        String(currentOrder.payment_status).toLowerCase() === "paid"
      ) {
        return jsonResponse({
          success: true,
          message: "Order already paid",
          order_number: orderNumber,
        });
      }

      return jsonResponse({
        success: false,
        message: "Order payment status could not be updated.",
      }, 409);
    }

    return jsonResponse({
      success: true,
      message: "Payment verified and order updated.",
      order_number: orderNumber,
      payment_status: "paid",
    });

  } catch (error) {
    console.error("ToyyibPay callback error:", error);

    return jsonResponse({
      success: false,
      message: "Callback processing failed.",
    }, 500);
  }
});
