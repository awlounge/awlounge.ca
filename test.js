import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

(async () => {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 100,
      currency: "cad",
      payment_method_types: ["card"],
    });
    console.log("✅ PaymentIntent created:", paymentIntent.id);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
})();
